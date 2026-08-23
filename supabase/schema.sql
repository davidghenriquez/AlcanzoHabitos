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
