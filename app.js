// ============================================================
// Creador de Hábitos — toda la lógica de la app en un único módulo:
// cliente de Supabase, auth (GitHub OAuth), CRUD de hábitos,
// gamificación (rachas/puntos/niveles) y render. Sin build step: se
// sirve tal cual (ver scripts/serve.ps1 para desarrollo local).
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const COLORS = ['#6d3bff', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#ec4899'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Hitos de racha que merecen una celebración especial (no solo confeti normal).
const STREAK_MILESTONES = {
  3: '¡Racha de 3 días! Ya es una costumbre 🌟',
  7: '¡Una semana entera! 🏆',
  14: '¡Dos semanas seguidas! Imparable 🚀',
  30: '¡Un mes de racha! Eres una leyenda 👑',
  60: '¡60 días! Esto ya es un estilo de vida 💎',
  100: '¡100 días de racha! INCREÍBLE 🎆',
};

// Frases de ánimo cortas para cuando se marca un hábito como hecho (sin hito).
const CHEERS = ['¡Genial! 🎉', '¡Así se hace! 💪', '¡Sigue así! 🔥', '¡Un paso más! ⭐', '¡Lo lograste! 🙌', '¡Imparable! 🚀'];

// El emoji de nivel sube de "tier" según el nivel actual — una mini evolución visual.
function levelEmoji(level) {
  if (level >= 10) return '🏆';
  if (level >= 7) return '⭐';
  if (level >= 5) return '🌳';
  if (level >= 3) return '🌿';
  return '🌱';
}

// ─────────────────────────────────────────────
// Gamificación: rachas, puntos y niveles.
// Todo se deriva de las completaciones guardadas, así que no hay
// contadores que puedan desincronizarse.
// ─────────────────────────────────────────────

function toUTCDate(dateStr) {
  // completed_on llega como 'YYYY-MM-DD'
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function computeStreak(completedDates) {
  if (completedDates.length === 0) {
    return { currentStreak: 0, longestStreak: 0, completedToday: false };
  }

  const uniqueDays = Array.from(new Set(completedDates)).sort();
  const dayTimes = uniqueDays.map((d) => toUTCDate(d).getTime());

  let longestStreak = 1;
  let running = 1;
  for (let i = 1; i < dayTimes.length; i++) {
    const diffDays = Math.round((dayTimes[i] - dayTimes[i - 1]) / MS_PER_DAY);
    if (diffDays === 1) {
      running += 1;
    } else {
      running = 1;
    }
    longestStreak = Math.max(longestStreak, running);
  }

  const today = todayUTC();
  const lastDay = dayTimes[dayTimes.length - 1];
  const diffFromToday = Math.round((today.getTime() - lastDay) / MS_PER_DAY);
  const completedToday = diffFromToday === 0;

  if (diffFromToday > 1) {
    return { currentStreak: 0, longestStreak, completedToday: false };
  }

  let currentStreak = 1;
  for (let i = dayTimes.length - 1; i > 0; i--) {
    const diff = Math.round((dayTimes[i] - dayTimes[i - 1]) / MS_PER_DAY);
    if (diff === 1) {
      currentStreak += 1;
    } else {
      break;
    }
  }

  return { currentStreak, longestStreak, completedToday };
}

function computeTotalPoints(habits, completions) {
  const pointsByHabit = new Map(habits.map((h) => [h.id, h.points_per_completion]));
  return completions.reduce((total, c) => total + (pointsByHabit.get(c.habit_id) ?? 0), 0);
}

function computeLevel(totalPoints) {
  let level = 1;
  let floor = 0;
  let span = 100;

  while (totalPoints >= floor + span) {
    floor += span;
    level += 1;
    span += 50; // cada nivel exige un poco más
  }

  const pointsIntoLevel = totalPoints - floor;
  const progress = pointsIntoLevel / span;

  return { level, pointsIntoLevel, pointsForNextLevel: span, progress };
}

// ─────────────────────────────────────────────
// Estado + cliente de Supabase
// ─────────────────────────────────────────────

let supabase = null;
let newHabitColor = COLORS[0];
// lastLevel empieza en null: así el primer render (al cargar sesión) nunca
// dispara la celebración de "subiste de nivel" para un nivel que el usuario
// ya tenía de antes.
const state = { user: null, habits: [], completions: [], lastLevel: null };

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function showFatalError(message) {
  const el = document.getElementById('fatalError');
  el.textContent = message;
  el.hidden = false;
  document.getElementById('loginGate').hidden = true;
  document.getElementById('appShell').hidden = true;
}

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function isMissingTablesError(err) {
  return err?.code === 'PGRST205' || /could not find the table/i.test(err?.message ?? '');
}

function showSetupBanner(message) {
  const el = document.getElementById('setupBanner');
  el.textContent = message;
  el.hidden = false;
}

function hideSetupBanner() {
  document.getElementById('setupBanner').hidden = true;
}

function friendlyError(err) {
  if (isMissingTablesError(err)) {
    return 'Faltan las tablas en Supabase — ejecuta supabase/schema.sql en el SQL Editor de tu proyecto y recarga la página.';
  }
  return err.message;
}

// ─────────────────────────────────────────────
// Celebraciones: confeti, sonido y mensajes de ánimo. Todo generado en
// JS/CSS puro (sin librerías ni archivos externos) para que funcione
// offline y sin build step.
// ─────────────────────────────────────────────

function spawnConfetti(x, y) {
  const container = document.createElement('div');
  container.className = 'confetti-burst';
  container.style.left = `${x}px`;
  container.style.top = `${y}px`;
  document.body.appendChild(container);

  const pieceCount = 20;
  for (let i = 0; i < pieceCount; i++) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    const angle = (Math.PI * 2 * i) / pieceCount + Math.random() * 0.6;
    const distance = 50 + Math.random() * 70;
    piece.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    piece.style.setProperty('--dy', `${Math.sin(angle) * distance - 30}px`);
    piece.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    piece.style.background = COLORS[i % COLORS.length];
    piece.style.animationDelay = `${Math.random() * 60}ms`;
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 1000);
}

let audioCtx = null;
function playChime(ascending) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const notes = ascending ? [523.25, 659.25, 783.99, 1046.5] : [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.35);
    });
  } catch {
    // Web Audio no disponible (política de autoplay, navegador viejo, etc.) — sin sonido, sin drama.
  }
}

function celebrateCompletion(x, y, currentStreak) {
  spawnConfetti(x, y);
  playChime(false);
  const milestoneMessage = STREAK_MILESTONES[currentStreak];
  showToast(milestoneMessage ?? CHEERS[Math.floor(Math.random() * CHEERS.length)]);
}

function celebrateLevelUp(level) {
  spawnConfetti(window.innerWidth / 2, window.innerHeight / 3);
  playChime(true);
  const banner = document.getElementById('levelUpBanner');
  banner.textContent = `${levelEmoji(level)} ¡Subiste a Nivel ${level}!`;
  banner.hidden = false;
  banner.classList.add('-show');
  setTimeout(() => {
    banner.classList.remove('-show');
    setTimeout(() => { banner.hidden = true; }, 300);
  }, 2600);
}

// ─────────────────────────────────────────────
// Acciones (auth + CRUD)
// ─────────────────────────────────────────────

async function signInWithGithub() {
  await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
}

async function signOut() {
  await supabase.auth.signOut();
}

async function loadData() {
  const [{ data: habits, error: habitsError }, { data: completions, error: completionsError }] =
    await Promise.all([
      supabase
        .from('habits')
        .select('*')
        .eq('user_id', state.user.id)
        .order('created_at', { ascending: true }),
      supabase.from('habit_completions').select('*').eq('user_id', state.user.id),
    ]);

  const loadError = habitsError || completionsError;
  if (loadError) {
    if (isMissingTablesError(loadError)) {
      showSetupBanner(
        'Falta terminar la configuración de Supabase: las tablas de la base de datos no existen ' +
        'todavía. Ve al SQL Editor de tu proyecto de Supabase y ejecuta el contenido de ' +
        'supabase/schema.sql, luego recarga esta página.'
      );
    } else {
      showToast(loadError.message);
    }
    return;
  }

  hideSetupBanner();
  state.habits = habits ?? [];
  state.completions = completions ?? [];
  renderDashboard();
}

async function createHabit({ name, description, color, points }) {
  const { error } = await supabase.from('habits').insert({
    user_id: state.user.id,
    name,
    description: description || null,
    color,
    points_per_completion: points,
  });
  if (error) throw error;
  await loadData();
}

async function toggleCompletionToday(habitId, isCompleted) {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (isCompleted) {
    const { error } = await supabase
      .from('habit_completions')
      .delete()
      .eq('habit_id', habitId)
      .eq('user_id', state.user.id)
      .eq('completed_on', todayStr);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('habit_completions')
      .insert({ habit_id: habitId, user_id: state.user.id });
    if (error) throw error;
  }
  await loadData();
}

async function archiveHabit(habitId) {
  const { error } = await supabase
    .from('habits')
    .update({ archived: true })
    .eq('id', habitId)
    .eq('user_id', state.user.id);
  if (error) throw error;
  await loadData();
}

// ─────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────

function displayName(user) {
  return user.user_metadata?.user_name ?? user.user_metadata?.full_name ?? user.email ?? 'tú';
}

function render() {
  const loginGate = document.getElementById('loginGate');
  const appShell = document.getElementById('appShell');

  if (state.user) {
    loginGate.hidden = true;
    appShell.hidden = false;
    document.getElementById('greetingText').textContent = `Hola, ${displayName(state.user)} 👋`;
  } else {
    loginGate.hidden = false;
    appShell.hidden = true;
  }
}

function renderDashboard() {
  const allHabits = state.habits;
  const allCompletions = state.completions;
  const activeHabits = allHabits.filter((h) => !h.archived);

  const completionsByHabit = new Map();
  for (const c of allCompletions) {
    const arr = completionsByHabit.get(c.habit_id) ?? [];
    arr.push(c.completed_on);
    completionsByHabit.set(c.habit_id, arr);
  }

  const totalPoints = computeTotalPoints(allHabits, allCompletions);
  const levelInfo = computeLevel(totalPoints);
  renderLevelCard(totalPoints, levelInfo);

  if (state.lastLevel !== null && levelInfo.level > state.lastLevel) {
    celebrateLevelUp(levelInfo.level);
  }
  state.lastLevel = levelInfo.level;

  const list = document.getElementById('habitsList');
  const empty = document.getElementById('habitsEmpty');

  if (activeHabits.length === 0) {
    list.innerHTML = '';
    empty.hidden = false;
  } else {
    empty.hidden = true;
    list.innerHTML = activeHabits
      .map((habit) => {
        const dates = completionsByHabit.get(habit.id) ?? [];
        const streak = computeStreak(dates);
        return renderHabitCard(habit, streak, new Set(dates));
      })
      .join('');
  }
}

function renderLevelCard(totalPoints, levelInfo) {
  const pct = Math.min(100, Math.round(levelInfo.progress * 100));
  document.getElementById('levelNumber').textContent = `${levelEmoji(levelInfo.level)} Nivel ${levelInfo.level}`;
  document.getElementById('totalPoints').textContent = String(totalPoints);
  document.getElementById('levelProgressBar').style.width = `${pct}%`;
  document.getElementById('levelProgressText').textContent =
    `${levelInfo.pointsIntoLevel} / ${levelInfo.pointsForNextLevel} puntos para el nivel ${levelInfo.level + 1}`;
}

// Últimos 7 días (hoy incluido, a la derecha) como puntos de "hecho/no hecho" —
// da una foto visual de la constancia, al estilo del grid de contribuciones de GitHub.
function renderWeekDots(completedDatesSet, color) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayUTC().getTime() - i * MS_PER_DAY);
    const key = d.toISOString().slice(0, 10);
    days.push(completedDatesSet.has(key));
  }
  return `<div class="week-dots">${days
    .map((done) => `<span class="week-dot ${done ? '-done' : ''}" style="${done ? `background:${escapeHtml(color)}` : ''}"></span>`)
    .join('')}</div>`;
}

function renderHabitCard(habit, streak, completedDatesSet) {
  const streakBadge = streak.currentStreak > 0
    ? `<span class="streak-badge">🔥 ${streak.currentStreak} ${streak.currentStreak === 1 ? 'día' : 'días'}</span>`
    : '';
  const description = habit.description
    ? `<p class="habit-description">${escapeHtml(habit.description)}</p>`
    : '';

  return `
    <div class="habit-card" style="border-left-color: ${escapeHtml(habit.color)}" data-habit-id="${habit.id}">
      <div class="habit-main">
        <div class="habit-title-row">
          <h3 class="habit-name">${escapeHtml(habit.name)}</h3>
          ${streakBadge}
        </div>
        ${description}
        <p class="habit-meta">
          +${habit.points_per_completion} pts/día · racha más larga: ${streak.longestStreak}
          ${streak.longestStreak === 1 ? 'día' : 'días'}
        </p>
        ${renderWeekDots(completedDatesSet, habit.color)}
      </div>
      <div class="habit-actions">
        <button
          type="button"
          class="habit-toggle ${streak.completedToday ? '-done' : ''}"
          data-action="toggle"
          data-completed="${streak.completedToday}"
          aria-label="${streak.completedToday ? 'Marcar como no hecho hoy' : 'Marcar como hecho hoy'}"
        >${streak.completedToday ? '✓' : ''}</button>
        <button type="button" class="habit-archive" data-action="archive">Archivar</button>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────
// Formulario de nuevo hábito
// ─────────────────────────────────────────────

function renderColorSwatches() {
  const wrap = document.getElementById('colorSwatches');
  wrap.innerHTML = COLORS.map((c) => `
    <button
      type="button"
      class="color-swatch ${c === newHabitColor ? '-selected' : ''}"
      style="background-color: ${c}"
      data-color="${c}"
      aria-label="Elegir color ${c}"
    ></button>
  `).join('');
}

function setNewHabitFormOpen(isOpen) {
  document.getElementById('newHabitToggle').hidden = isOpen;
  document.getElementById('newHabitForm').hidden = !isOpen;
}

function resetNewHabitForm() {
  const form = document.getElementById('newHabitForm');
  form.reset();
  newHabitColor = COLORS[0];
  renderColorSwatches();
}

// ─────────────────────────────────────────────
// Eventos (delegación: el DOM del dashboard se re-renderiza entero)
// ─────────────────────────────────────────────

function wireStaticEvents() {
  document.getElementById('githubLoginBtn').addEventListener('click', () => {
    signInWithGithub().catch((err) => showToast(err.message));
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    signOut().catch((err) => showToast(err.message));
  });

  document.getElementById('habitsList').addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const card = target.closest('[data-habit-id]');
    const habitId = card.dataset.habitId;

    if (target.dataset.action === 'toggle') {
      const isCompleted = target.dataset.completed === 'true';
      const wasCompleting = !isCompleted;
      // El botón se re-renderiza (y el nodo actual queda desconectado del DOM)
      // en cuanto loadData() reconstruye la lista, así que hay que capturar su
      // posición ANTES de la llamada async, no después.
      const rect = target.getBoundingClientRect();
      const originX = rect.left + rect.width / 2;
      const originY = rect.top + rect.height / 2;
      target.disabled = true;
      toggleCompletionToday(habitId, isCompleted)
        .then(() => {
          if (!wasCompleting) return;
          const dates = state.completions.filter((c) => c.habit_id === habitId).map((c) => c.completed_on);
          const { currentStreak } = computeStreak(dates);
          celebrateCompletion(originX, originY, currentStreak);
        })
        .catch((err) => showToast(friendlyError(err)))
        .finally(() => { target.disabled = false; });
    } else if (target.dataset.action === 'archive') {
      target.disabled = true;
      archiveHabit(habitId)
        .catch((err) => showToast(friendlyError(err)))
        .finally(() => { target.disabled = false; });
    }
  });

  document.getElementById('newHabitToggle').addEventListener('click', () => {
    setNewHabitFormOpen(true);
  });

  document.getElementById('newHabitCancel').addEventListener('click', () => {
    resetNewHabitForm();
    setNewHabitFormOpen(false);
  });

  document.getElementById('colorSwatches').addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-color]');
    if (!swatch) return;
    newHabitColor = swatch.dataset.color;
    renderColorSwatches();
  });

  document.getElementById('newHabitForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    const submitBtn = document.getElementById('newHabitSubmit');
    const name = form.name.value.trim();
    if (!name) return;

    const pointsRaw = Number(form.points_per_completion.value);
    const points = Number.isFinite(pointsRaw) && pointsRaw > 0 ? Math.round(pointsRaw) : 10;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creando...';
    createHabit({ name, description: form.description.value.trim(), color: newHabitColor, points })
      .then(() => {
        resetNewHabitForm();
        setNewHabitFormOpen(false);
      })
      .catch((err) => showToast(friendlyError(err)))
      .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Crear hábito';
      });
  });
}

// ─────────────────────────────────────────────
// Arranque
// ─────────────────────────────────────────────

async function init() {
  if (!window.SUPABASE_CONFIG || !window.SUPABASE_CONFIG.url || window.SUPABASE_CONFIG.url.includes('TU-PROYECTO')) {
    showFatalError(
      'Falta configurar supabase-config.js — copia supabase-config.example.js, ' +
      'rellena la URL y la anon key de tu proyecto de Supabase, y recarga la página.'
    );
    return;
  }

  supabase = createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
  renderColorSwatches();
  wireStaticEvents();

  supabase.auth.onAuthStateChange((_event, session) => {
    state.user = session?.user ?? null;
    render();
    if (state.user) loadData();
  });

  const { data: { session } } = await supabase.auth.getSession();
  state.user = session?.user ?? null;
  render();
  if (state.user) await loadData();
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => showFatalError(err.message));
});
