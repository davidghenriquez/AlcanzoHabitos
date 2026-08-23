-- Esquema para "Creador de Hábitos"
-- Ejecuta este script en el SQL Editor de tu proyecto de Supabase.

-- Extensión necesaria para gen_random_uuid()
create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────
-- Tabla: habits
-- ─────────────────────────────────────────────
create table if not exists public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  description text,
  color text not null default '#6d3bff',
  points_per_completion integer not null default 10 check (points_per_completion > 0),
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists habits_user_id_idx on public.habits (user_id);

alter table public.habits enable row level security;

create policy "Los usuarios pueden ver sus propios hábitos"
  on public.habits for select
  using (auth.uid() = user_id);

create policy "Los usuarios pueden crear sus propios hábitos"
  on public.habits for insert
  with check (auth.uid() = user_id);

create policy "Los usuarios pueden editar sus propios hábitos"
  on public.habits for update
  using (auth.uid() = user_id);

create policy "Los usuarios pueden borrar sus propios hábitos"
  on public.habits for delete
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- Tabla: habit_completions
-- ─────────────────────────────────────────────
create table if not exists public.habit_completions (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references public.habits (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  completed_on date not null default (now() at time zone 'utc')::date,
  created_at timestamptz not null default now(),
  unique (habit_id, completed_on)
);

create index if not exists habit_completions_habit_id_idx on public.habit_completions (habit_id);
create index if not exists habit_completions_user_id_idx on public.habit_completions (user_id);

alter table public.habit_completions enable row level security;

create policy "Los usuarios pueden ver sus propias completaciones"
  on public.habit_completions for select
  using (auth.uid() = user_id);

create policy "Los usuarios pueden registrar sus propias completaciones"
  on public.habit_completions for insert
  with check (auth.uid() = user_id);

create policy "Los usuarios pueden borrar sus propias completaciones"
  on public.habit_completions for delete
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- Tabla: profiles
-- Perfil público mínimo (nombre + avatar) para el ranking. Cualquier
-- usuario autenticado puede leer todos los perfiles — así se puede
-- mostrar "quién es quién" en la tabla de puntos — pero solo puede
-- editar el suyo. No expone hábitos ni completaciones, solo identidad.
-- ─────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text,
  avatar_url text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Cualquier usuario autenticado puede ver los perfiles"
  on public.profiles for select
  to authenticated
  using (true);

create policy "Los usuarios pueden editar su propio perfil"
  on public.profiles for update
  using (auth.uid() = id);

-- Crea el perfil automáticamente al iniciar sesión por primera vez
-- (dispara con cada nuevo registro en auth.users, que Supabase crea al
-- completar el login de GitHub).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'user_name', new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────
-- Ranking entre usuarios
-- SECURITY DEFINER: se ejecuta con permisos elevados para poder sumar
-- los puntos de TODOS los usuarios (las tablas habits/habit_completions
-- tienen RLS que normalmente solo deja ver los propios). Solo devuelve
-- nombre + puntos totales — nunca los hábitos ni las fechas de nadie.
-- ─────────────────────────────────────────────
create or replace function public.get_leaderboard()
returns table (
  user_id uuid,
  username text,
  avatar_url text,
  total_points bigint
)
language sql
security definer set search_path = public
stable
as $$
  select
    p.id as user_id,
    coalesce(p.username, 'Jugador') as username,
    p.avatar_url,
    coalesce(sum(h.points_per_completion), 0)::bigint as total_points
  from public.profiles p
  left join public.habits h on h.user_id = p.id
  left join public.habit_completions c on c.habit_id = h.id
  group by p.id, p.username, p.avatar_url
  order by total_points desc;
$$;

grant execute on function public.get_leaderboard() to authenticated;

-- Si ya tenías la app en uso antes de añadir profiles, esto rellena el
-- perfil de las cuentas que ya existían (el trigger de arriba solo
-- aplica a registros nuevos).
insert into public.profiles (id, username, avatar_url)
select
  u.id,
  coalesce(u.raw_user_meta_data->>'user_name', u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)),
  u.raw_user_meta_data->>'avatar_url'
from auth.users u
on conflict (id) do nothing;
