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
const state = {
  user: null,
  habits: [],
  completions: [],
  lastLevel: null,
  activeTab: 'habits',
  calendarMonth: todayUTC(), // día 1 del mes visible en el calendario (siempre normalizado abajo)
  leaderboard: null,
  leaderboardError: null,
};

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

function isMissingSetupError(err) {
  return (
    err?.code === 'PGRST205' ||
    err?.code === 'PGRST202' ||
    /could not find the (table|function)/i.test(err?.message ?? '')
  );
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
  if (isMissingSetupError(err)) {
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
    if (isMissingSetupError(loadError)) {
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
  state.leaderboard = null; // los puntos cambiaron: que el ranking se recargue la próxima vez que se vea
  renderDashboard();
  if (state.activeTab === 'calendar') renderCalendar();
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
  const safeColor = escapeHtml(color);
  return `<div class="week-dots">${days
    .map((done) => `<span class="week-dot ${done ? '-done' : ''}" style="${done ? `background:${safeColor};color:${safeColor}` : ''}"></span>`)
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
// Calendario: puntos ganados por día, mes a mes. Se deriva de las
// mismas completaciones que ya tenemos en memoria — sin llamadas
// nuevas a Supabase.
// ─────────────────────────────────────────────

const MONTH_FORMATTER = new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function pointsByDateMap() {
  const pointsByHabit = new Map(state.habits.map((h) => [h.id, h.points_per_completion]));
  const map = new Map();
  for (const c of state.completions) {
    const pts = pointsByHabit.get(c.habit_id) ?? 0;
    map.set(c.completed_on, (map.get(c.completed_on) ?? 0) + pts);
  }
  return map;
}

function intensityLevel(points, maxPoints) {
  if (points <= 0 || maxPoints <= 0) return 0;
  const ratio = points / maxPoints;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function changeCalendarMonth(delta) {
  const year = state.calendarMonth.getUTCFullYear();
  const month = state.calendarMonth.getUTCMonth();
  state.calendarMonth = new Date(Date.UTC(year, month + delta, 1));
  renderCalendar();
}

function renderCalendar() {
  const pointsByDate = pointsByDateMap();
  const year = state.calendarMonth.getUTCFullYear();
  const month = state.calendarMonth.getUTCMonth();

  document.getElementById('calMonthLabel').textContent = MONTH_FORMATTER.format(state.calendarMonth);

  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // getUTCDay(): 0=domingo..6=sábado → offset con la semana empezando en lunes
  const startOffset = (firstOfMonth.getUTCDay() + 6) % 7;

  const dayPoints = [];
  let monthTotal = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const key = new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
    const pts = pointsByDate.get(key) ?? 0;
    monthTotal += pts;
    dayPoints.push({ day, key, pts });
  }
  const maxPoints = Math.max(1, ...dayPoints.map((d) => d.pts));
  const todayKey = todayUTC().toISOString().slice(0, 10);

  document.getElementById('calMonthTotal').textContent =
    `${monthTotal} ${monthTotal === 1 ? 'punto' : 'puntos'} este mes`;

  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push('<div class="calendar-cell -empty"></div>');
  }
  for (const { day, key, pts } of dayPoints) {
    const level = intensityLevel(pts, maxPoints);
    const isToday = key === todayKey;
    cells.push(`
      <div class="calendar-cell -level${level} ${isToday ? '-today' : ''}" title="${key}: ${pts} pts">
        <span class="calendar-cell-day">${day}</span>
        ${pts > 0 ? `<span class="calendar-cell-pts">${pts}</span>` : ''}
      </div>
    `);
  }

  document.getElementById('calendarGrid').innerHTML = cells.join('');
}

// ─────────────────────────────────────────────
// Ranking: compara puntos totales entre todos los usuarios de la app
// (RPC en Supabase con SECURITY DEFINER — ver supabase/schema.sql).
// Los hábitos y completaciones de cada quién siguen siendo privados;
// solo se comparten nombre, avatar y puntos totales.
// ─────────────────────────────────────────────

async function loadLeaderboard() {
  renderRankingLoading();
  const { data, error } = await supabase.rpc('get_leaderboard');
  if (error) {
    state.leaderboardError = error;
    state.leaderboard = null;
  } else {
    state.leaderboard = data ?? [];
    state.leaderboardError = null;
  }
  renderRanking();
}

function renderRankingLoading() {
  document.getElementById('rankingList').innerHTML = '<p class="ranking-status">Cargando ranking…</p>';
}

function renderRanking() {
  const list = document.getElementById('rankingList');

  if (state.leaderboardError) {
    const message = isMissingSetupError(state.leaderboardError)
      ? 'El ranking necesita la función get_leaderboard() en Supabase — ejecuta la versión actualizada de supabase/schema.sql y recarga la página.'
      : friendlyError(state.leaderboardError);
    list.innerHTML = `<p class="ranking-status">${escapeHtml(message)}</p>`;
    return;
  }

  if (!state.leaderboard || state.leaderboard.length === 0) {
    list.innerHTML = '<p class="ranking-status">Todavía no hay nadie en el ranking.</p>';
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  list.innerHTML = state.leaderboard
    .map((row, i) => {
      const isMe = row.user_id === state.user.id;
      const levelInfo = computeLevel(row.total_points);
      const rankLabel = medals[i] ?? `#${i + 1}`;
      const initial = escapeHtml((row.username || '?').charAt(0).toUpperCase());
      const avatar = row.avatar_url
        ? `<img class="ranking-avatar" src="${escapeHtml(row.avatar_url)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ranking-avatar -placeholder',textContent:'${initial}'}))" />`
        : `<div class="ranking-avatar -placeholder">${initial}</div>`;
      return `
        <div class="ranking-row ${isMe ? '-me' : ''}">
          <span class="ranking-rank">${rankLabel}</span>
          ${avatar}
          <div class="ranking-info">
            <p class="ranking-name">${escapeHtml(row.username)}${isMe ? ' <span class="ranking-you-tag">Tú</span>' : ''}</p>
            <p class="ranking-level">${levelEmoji(levelInfo.level)} Nivel ${levelInfo.level}</p>
          </div>
          <span class="ranking-points">${row.total_points} pts</span>
        </div>
      `;
    })
    .join('');
}

// ─────────────────────────────────────────────
// Pestañas
// ─────────────────────────────────────────────

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('-active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });

  if (tab === 'calendar') renderCalendar();
  if (tab === 'ranking' && state.leaderboard === null) loadLeaderboard();
}

function wireTabs() {
  document.getElementById('tabBar').addEventListener('click', (event) => {
    const btn = event.target.closest('.tab-btn');
    if (!btn) return;
    setActiveTab(btn.dataset.tab);
  });

  document.getElementById('calPrevMonth').addEventListener('click', () => changeCalendarMonth(-1));
  document.getElementById('calNextMonth').addEventListener('click', () => changeCalendarMonth(1));
  document.getElementById('rankingRefresh').addEventListener('click', () => loadLeaderboard());
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
  wireTabs();

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
