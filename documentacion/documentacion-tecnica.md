# Creador de Hábitos · Documentación técnica

Tracker de hábitos con gamificación (rachas, puntos, niveles) y login con
GitHub. Es una **app 100% estática** (sin servidor propio): usa el SDK de
Supabase directamente desde el navegador para auth y datos, con Row Level
Security como única capa de protección. Pensada para GitHub Pages o
cualquier hosting estático.

---

## 1. Estructura de archivos

```
index.html                    Estructura de la página (login gate + dashboard)
styles.css                    Estética clara, paleta "brand" (violeta)
app.js                        Toda la lógica: auth, CRUD de hábitos, gamificación, render
supabase-config.example.js    Plantilla de configuración de Supabase (SÍ se sube a git)
supabase-config.js            Configuración real local (NO se sube, está en .gitignore)
supabase/schema.sql           Esquema SQL con RLS — se ejecuta a mano en el SQL Editor de Supabase
scripts/serve.ps1             Servidor estático local para desarrollo
documentacion/                Esta guía
.gitignore
```

No hay build step: los archivos se sirven tal cual.

---

## 2. Flujo de carga de la app

1. `index.html` carga `supabase-config.js` (si existe) y luego `app.js`
   como módulo ES. `app.js` importa `@supabase/supabase-js` directamente
   desde un CDN (`esm.run` / jsdelivr `+esm`) — no hace falta `npm
   install`.
2. Si `window.SUPABASE_CONFIG` no está definido o sigue con los valores
   de plantilla, se muestra un aviso fijo en pantalla (`#fatalError`) en
   vez de dejar la app rota en silencio.
3. Al arrancar, `init()` crea el cliente de Supabase, se suscribe a
   `onAuthStateChange` y comprueba la sesión actual (`getSession`). Según
   haya o no usuario, se muestra `#loginGate` o `#appShell`.
4. Con sesión activa se cargan en paralelo `habits` y `habit_completions`
   del usuario (`loadData`) y se renderiza el dashboard completo
   (`renderDashboard`): el DOM de la lista de hábitos se reconstruye
   entero en cada cambio, no hay diffing — es intencionalmente simple.

---

## 3. Autenticación (GitHub OAuth vía Supabase)

- `signInWithGithub()` llama a `supabase.auth.signInWithOAuth({provider:
  'github', options: { redirectTo: window.location.origin +
  window.location.pathname }})`. Al volver de GitHub, el propio SDK de
  Supabase detecta el código en la URL y completa el login — no hace
  falta una ruta `/auth/callback` como en un framework con servidor.
- Hay que añadir la URL donde sirvas la app (p. ej.
  `http://localhost:8123/` o tu dominio de GitHub Pages) tanto en la
  OAuth App de GitHub como en **Authentication → URL Configuration →
  Redirect URLs** de Supabase.
- `signOut()` simplemente llama a `supabase.auth.signOut()`; el listener
  de `onAuthStateChange` se encarga de volver a mostrar el login gate.

---

## 4. Datos y RLS (`supabase/schema.sql`)

Dos tablas, `habits` y `habit_completions`, cada una con Row Level
Security activada y policies que comparan `auth.uid() = user_id`. Como
todas las queries se hacen desde el navegador con la `anon key`, RLS es
la única barrera real entre los datos de un usuario y los de otro — por
eso el esquema no cambia aunque ya no haya servidor: la protección nunca
dependió de código de servidor, dependía de Postgres.

---

## 5. Gamificación (`app.js`)

Misma lógica que en la versión anterior (Next.js), portada 1:1 a JS
plano:

- **Puntos**: cada hábito tiene `points_per_completion`. El total del
  usuario es la suma de puntos de todas sus completaciones — no hay
  contador que se pueda desincronizar.
- **Nivel**: curva creciente a partir de los puntos totales (nivel 1:
  0–99 pts, nivel 2: 100–249, nivel 3: 250–449...). Ver `computeLevel`.
- **Racha**: días consecutivos completados, contando hacia atrás desde
  hoy (o ayer, si hoy aún no se ha marcado). Ver `computeStreak`.

---

## 6. Renderizado y seguridad

- No hay framework: `renderDashboard`/`renderHabitCard` generan HTML por
  interpolación de strings. Todo texto que viene del usuario (nombre y
  descripción del hábito) pasa por `escapeHtml()` antes de insertarse en
  el DOM para evitar XSS.
- Los eventos de la lista de hábitos usan delegación
  (`habitsList.addEventListener('click', ...)` + `data-action`) en vez
  de listeners por tarjeta, porque la lista se reconstruye entera en
  cada `renderDashboard()`.
