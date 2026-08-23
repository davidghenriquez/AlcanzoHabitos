// ============================================================
// Copia este archivo como "supabase-config.js" (misma carpeta) y
// rellena los valores de tu proyecto de Supabase (Project Settings
// → API). Ese archivo NO se sube a git (está en .gitignore).
//
// A diferencia de una API key normal, la "anon key" de Supabase está
// pensada para exponerse en el navegador: la protección real de los
// datos la da Row Level Security (ver supabase/schema.sql), no el
// secreto de esta clave. Por eso, si despliegas en GitHub Pages u
// otro hosting estático, puedes subir supabase-config.js sin riesgo
// (fuérzalo con `git add -f supabase-config.js` si quieres).
// ============================================================

window.SUPABASE_CONFIG = {
  url: 'https://TU-PROYECTO.supabase.co',
  anonKey: 'TU-ANON-KEY-PUBLICA',
};
