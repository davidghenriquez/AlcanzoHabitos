# Creador de Hábitos

Tracker de hábitos con gamificación (rachas, puntos y niveles), construido
como **app 100% estática** (HTML/CSS/JS plano, sin build step) con login de
GitHub y datos en Supabase.

## Funcionalidades

- Login con GitHub (OAuth vía Supabase Auth).
- Crear, completar (marcar el día de hoy) y archivar hábitos.
- Racha actual y racha más larga por hábito (🔥).
- Puntos por cada completación (configurables por hábito) y nivel global con
  barra de progreso.
- Cada usuario solo ve y modifica sus propios datos (Row Level Security en
  Postgres).

## 1. Requisitos

- Un navegador moderno. **No hace falta Node.js ni `npm install`** — no hay
  build step, `app.js` importa `@supabase/supabase-js` directamente desde un
  CDN.
- Una cuenta gratuita en [Supabase](https://supabase.com).
- Una cuenta de GitHub (para crear la OAuth App).

## 2. Crear el proyecto en Supabase

1. Entra en [supabase.com](https://supabase.com) → **New project**.
2. Cuando esté listo, ve a **SQL Editor** y pega el contenido de
   [`supabase/schema.sql`](./supabase/schema.sql). Ejecútalo — esto crea las
   tablas `habits` y `habit_completions` con Row Level Security activada.
3. Ve a **Project Settings → API** y copia:
   - `Project URL`
   - `anon public` key

## 3. Configurar login con GitHub

1. En GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.
   - **Homepage URL**: `http://localhost:8123` (en producción, tu dominio).
   - **Authorization callback URL**:
     `https://<TU-PROYECTO>.supabase.co/auth/v1/callback`
     (lo encuentras en Supabase → Authentication → Providers → GitHub).
2. Copia el **Client ID** y genera un **Client Secret**.
3. En Supabase: **Authentication → Providers → GitHub** → actívalo y pega el
   Client ID / Secret. Guarda.
4. En Supabase: **Authentication → URL Configuration**:
   - **Site URL**: `http://localhost:8123`
   - **Redirect URLs**: añade `http://localhost:8123/` (y, cuando despliegues,
     la URL de producción).

## 4. Configurar Supabase en la app

```bash
cp supabase-config.example.js supabase-config.js
```

Rellena `supabase-config.js` con los valores del paso 2 (`url`, `anonKey`).
Este archivo está en `.gitignore` por consistencia con el resto de configs
locales del proyecto, pero la `anon key` **no es un secreto real** — la
protección de los datos la da Row Level Security, no esta clave. Si
despliegas en un hosting estático (GitHub Pages, etc.) puedes subirlo sin
problema (`git add -f supabase-config.js`).

## 5. Ejecutar en local

```bash
powershell -ExecutionPolicy Bypass -File scripts/serve.ps1
```

Abre [http://localhost:8123](http://localhost:8123) — te muestra la pantalla
de login, entras con GitHub y llegas al dashboard.

(Cualquier otro servidor estático sirve igual — `python -m http.server`,
`npx serve`, la extensión "Live Server" de VS Code, etc. Solo hace falta que
sirva los archivos por HTTP, no `file://`, para que el módulo ES y el OAuth
funcionen bien.)

## Estructura del proyecto

```
index.html                    login gate + dashboard, todo en una página
styles.css                    estilos
app.js                        auth, CRUD de hábitos, gamificación, render
supabase-config.example.js    plantilla de configuración (se sube a git)
supabase-config.js            configuración real local (NO se sube)
supabase/schema.sql           esquema SQL con RLS
scripts/serve.ps1             servidor estático local
documentacion/                documentación técnica
```

Ver [`documentacion/documentacion-tecnica.md`](./documentacion/documentacion-tecnica.md)
para el detalle de cómo encajan las piezas.

## Cómo funciona la gamificación

- **Puntos**: cada hábito tiene `points_per_completion` (por defecto 10). El
  total del usuario es la suma de puntos de todas sus completaciones — no hay
  contador que se pueda desincronizar.
- **Nivel**: se calcula a partir de los puntos totales con una curva
  creciente (nivel 1: 0–99 pts, nivel 2: 100–249 pts, nivel 3: 250–449 pts...).
  Ver `computeLevel` en `app.js`.
- **Racha**: días consecutivos con el hábito completado, contando hacia atrás
  desde hoy (o ayer, si hoy aún no lo has marcado). Ver `computeStreak`.

## Desplegar

Al no haber build step, funciona igual en [GitHub Pages](https://pages.github.com/)
o [Vercel](https://vercel.com) como sitio estático: sube los archivos tal
cual, añade `supabase-config.js` con los valores de producción y añade esa
URL a los Redirect URLs de Supabase.
