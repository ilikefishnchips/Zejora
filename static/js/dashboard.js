// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  subjects: [],
  tasks: [],
  analytics: null,
  procrastination: null,
  charts: {},
  calendarDate: new Date(),
  calendarSelectedDate: null,
  searchQuery: '',
  filterStatus: 'all',
  filterPriority: 'all',
  filterSubject: null,
  reminderInterval: null,
  notifiedKeys: new Set(),
};

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(v = '') {
  return String(v).replace(/[&<>'"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]
  ));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = body.detail;
    const msg = typeof d === 'string' ? d
      : Array.isArray(d) ? (d[0]?.msg || 'Please check the form and try again.')
      : (d?.message || 'Something went wrong.');
    const err = new Error(msg);
    err.detail = d;
    err.status = res.status;
    throw err;
  }
  return body;
}

function showToast(message, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  $('#toast-region').append(t);
  setTimeout(() => t.remove(), 3200);
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayOffset(date) {
  const due = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

function formatDue(task) {
  const due = new Date(task.due_at);
  const off = dayOffset(due);
  const label = off === 0 ? 'Today' : off === 1 ? 'Tomorrow' : off === -1 ? 'Yesterday'
    : due.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${label} · ${due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function toDatetimeLocal(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function defaultDueTime() {
  const d = new Date(Date.now() + 3600000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return toDatetimeLocal(d.toISOString());
}

function msToLabel(ms) {
  if (ms <= 0) return 'overdue';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(ms / 3600000);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ─── Dark mode ────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const icon = theme === 'dark' ? '☀' : '☽';
  $$('[data-theme-icon]').forEach((el) => { el.textContent = icon; });
  localStorage.setItem('zejora-theme', theme);
  if (state.analytics) renderCharts();
}

function toggleDarkMode() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

function initTheme() {
  applyTheme(localStorage.getItem('zejora-theme') || 'light');
}

// ─── Notifications ────────────────────────────────────────────────────────────
function getReminderSettings() {
  const defaults = { enabled: true, h24: true, h1: true, overdue: true, interval: 300000 };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('zejora-reminders') || '{}') }; }
  catch { return defaults; }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

function sendNotification(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!getReminderSettings().enabled) return;
  try { new Notification(title, { body, tag }); } catch {}
}

function checkDeadlines() {
  const s = getReminderSettings();
  if (!s.enabled) return;
  const now = Date.now();
  state.tasks.filter((t) => !t.completed).forEach((task) => {
    const due = new Date(task.due_at).getTime();
    const diff = due - now;
    const k24 = `24h-${task.id}`;
    const k1 = `1h-${task.id}`;
    const kov = `ov-${task.id}`;
    if (s.h24 && diff > 0 && diff <= 86400000 && !state.notifiedKeys.has(k24)) {
      sendNotification(
        `📚 Due in ${msToLabel(diff)}: ${task.title}`,
        `${task.subject.name} · You've got this!`,
        k24
      );
      state.notifiedKeys.add(k24);
    }
    if (s.h1 && diff > 0 && diff <= 3600000 && !state.notifiedKeys.has(k1)) {
      sendNotification(
        `⏰ Due very soon: ${task.title}`,
        `${task.subject.name} · Less than an hour!`,
        k1
      );
      state.notifiedKeys.add(k1);
    }
    if (s.overdue && diff < 0 && !state.notifiedKeys.has(kov)) {
      sendNotification(
        `⚠️ Overdue: ${task.title}`,
        `${task.subject.name} · Needs your attention.`,
        kov
      );
      state.notifiedKeys.add(kov);
    }
  });
}

function setupReminderInterval(s) {
  if (state.reminderInterval) clearInterval(state.reminderInterval);
  if (s.enabled) state.reminderInterval = setInterval(checkDeadlines, s.interval);
}

async function initNotifications() {
  const s = getReminderSettings();
  if (s.enabled) {
    await requestNotificationPermission();
    setupReminderInterval(s);
  }
}

function loadReminderForm() {
  const s = getReminderSettings();
  $('#notif-enabled').checked = s.enabled;
  $('#notif-24h').checked = s.h24;
  $('#notif-1h').checked = s.h1;
  $('#notif-overdue').checked = s.overdue;
  $('#reminder-interval').value = s.interval;
  const el = $('#notif-permission-status');
  if (!('Notification' in window)) {
    el.textContent = 'Your browser does not support notifications.';
    el.className = 'notif-status notif-error';
  } else if (Notification.permission === 'granted') {
    el.textContent = '✓ Notifications are enabled.';
    el.className = 'notif-status notif-ok';
  } else if (Notification.permission === 'denied') {
    el.textContent = '✗ Notifications are blocked in your browser settings.';
    el.className = 'notif-status notif-error';
  } else {
    el.textContent = 'Click Save to request notification permission.';
    el.className = 'notif-status';
  }
}

async function saveReminderSettings() {
  await requestNotificationPermission();
  const s = {
    enabled: $('#notif-enabled').checked,
    h24: $('#notif-24h').checked,
    h1: $('#notif-1h').checked,
    overdue: $('#notif-overdue').checked,
    interval: Number($('#reminder-interval').value),
  };
  localStorage.setItem('zejora-reminders', JSON.stringify(s));
  setupReminderInterval(s);
  showToast('Reminder settings saved.');
  $('#reminder-modal').close();
}

// ─── Task rendering ───────────────────────────────────────────────────────────
function taskCard(task) {
  const urgentBadge = task.state === 'urgent' ? '<span class="state-badge">Due soon</span>' : '';
  const overdueBadge = task.state === 'overdue' ? '<span class="state-badge overdue-badge">Overdue</span>' : '';
  const postponeBadge = task.postpone_count > 0 ? `<span class="postpone-badge" title="Postponed ${task.postpone_count} time(s)">⏩ ×${task.postpone_count}</span>` : '';
  const desc = task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : '';
  const postponeBtn = !task.completed ? `<button class="task-action postpone-btn" data-action="postpone-task" aria-label="Postpone 1 day" title="Postpone 1 day">⏩</button>` : '';
  return `
    <article class="task-card state-${task.state}" data-task-id="${task.id}">
      <input class="task-check" type="checkbox" ${task.completed ? 'checked' : ''}
        aria-label="Mark ${escapeHtml(task.title)} ${task.completed ? 'incomplete' : 'complete'}"
        data-action="toggle-task">
      <div class="task-content">
        <div class="task-title-row">
          <span class="task-title">${escapeHtml(task.title)}</span>
          <span class="priority-badge priority-${task.priority}">${task.priority}</span>
          ${urgentBadge}${overdueBadge}${postponeBadge}
        </div>
        <div class="task-meta">
          <span class="task-subject"><i class="subject-dot" style="background:${task.subject.color}"></i>${escapeHtml(task.subject.name)}</span>
          <span>${formatDue(task)}</span>
        </div>
        ${desc}
      </div>
      <div class="task-actions">
        ${postponeBtn}
        <button class="task-action" data-action="edit-task" aria-label="Edit" title="Edit">✎</button>
        <button class="task-action delete" data-action="delete-task" aria-label="Delete" title="Delete">×</button>
      </div>
    </article>`;
}

function applyFilters(tasks) {
  let f = tasks;
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    f = f.filter((t) =>
      t.title.toLowerCase().includes(q) ||
      (t.description || '').toLowerCase().includes(q) ||
      t.subject.name.toLowerCase().includes(q)
    );
  }
  if (state.filterStatus !== 'all') {
    f = f.filter((t) => {
      if (state.filterStatus === 'completed') return t.completed;
      if (state.filterStatus === 'pending') return !t.completed && t.state === 'pending';
      if (state.filterStatus === 'urgent') return t.state === 'urgent';
      if (state.filterStatus === 'overdue') return t.state === 'overdue';
      return true;
    });
  }
  if (state.filterPriority !== 'all') f = f.filter((t) => t.priority === state.filterPriority);
  if (state.filterSubject !== null) f = f.filter((t) => t.subject_id === state.filterSubject);
  return f;
}

function groupTasks(tasks) {
  const g = { today: [], overdue: [], upcoming: [], later: [], completed: [] };
  tasks.forEach((task) => {
    if (task.completed) { g.completed.push(task); return; }
    const due = new Date(task.due_at);
    const off = dayOffset(due);
    if (task.state === 'overdue') g.overdue.push(task);
    else if (dateKey(due) === dateKey(new Date())) g.today.push(task);
    else if (off >= 1 && off <= 7) g.upcoming.push(task);
    else g.later.push(task);
  });
  g.completed.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  return g;
}

function renderTaskGroups() {
  const filtered = applyFilters(state.tasks);
  const groups = groupTasks(filtered);
  ['today', 'overdue', 'upcoming', 'later', 'completed'].forEach((name) => {
    const tasks = groups[name];
    $(`#${name}-list`).innerHTML = tasks.map(taskCard).join('');
    $(`#${name}-empty`).hidden = tasks.length > 0;
  });
  $('#today-count').textContent = groups.today.length;
  $('#overdue-group-count').textContent = groups.overdue.length;
  $('#upcoming-count').textContent = groups.upcoming.length;
  $('#later-count').textContent = groups.later.length;
  $('#completed-count').textContent = groups.completed.length;
  $('#task-sections').hidden = state.subjects.length === 0;
  $('#empty-dashboard').hidden = state.subjects.length > 0;
}

// ─── Subjects ─────────────────────────────────────────────────────────────────
function renderSubjects() {
  $('#subject-list').innerHTML = state.subjects.map((s) => `
    <div class="subject-row ${state.filterSubject === s.id ? 'active' : ''}" data-subject-id="${s.id}">
      <button class="subject-filter" data-action="filter-subject" title="${escapeHtml(s.name)}">
        <i class="subject-dot" style="background:${s.color}"></i>
        <span>${escapeHtml(s.name)}</span>
        <span class="subject-task-count">${s.task_count}</span>
      </button>
      <button class="subject-menu" data-action="edit-subject" aria-label="Edit ${escapeHtml(s.name)}" title="Edit subject">•••</button>
    </div>`).join('');
  $('#subject-empty').hidden = state.subjects.length > 0;
  $('#all-count').textContent = state.tasks.length;
  $('#overdue-count').textContent = state.analytics?.summary.overdue || 0;
  $('#dashboard-subtitle').textContent = 'Here is what deserves your attention today.';
}

// ─── Summary cards ────────────────────────────────────────────────────────────
function renderSummary() {
  const s = state.analytics?.summary;
  if (!s) return;
  $('#stat-today').textContent = s.due_today;
  $('#stat-upcoming').textContent = s.due_next_7_days;
  $('#stat-overdue').textContent = s.overdue;
  $('#stat-completed').textContent = s.completed;
  $('#completion-value').textContent = `${s.completion_rate}%`;
  $('#completion-ring').style.setProperty('--progress', s.completion_rate);
  $('#chart-completion').textContent = `${s.completion_rate}%`;
  $('#chart-total').textContent = s.total;
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function chartDefaults() {
  if (!window.Chart) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  Chart.defaults.font.family = 'Outfit, Segoe UI, sans-serif';
  Chart.defaults.color = dark ? '#a8a09a' : '#78716C';
  Chart.defaults.borderColor = dark ? 'rgba(255,255,255,0.07)' : 'rgba(41,37,36,0.07)';
}

function upsertChart(name, id, config) {
  if (!window.Chart) return;
  if (state.charts[name]) state.charts[name].destroy();
  state.charts[name] = new Chart($(`#${id}`), config);
}

function renderCharts() {
  if (!state.analytics || !window.Chart) return;
  chartDefaults();
  const { weekly_completion, status_distribution: st, priority_distribution: pr, subject_workload: wl } = state.analytics;
  const noAnim = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const common = { responsive: true, maintainAspectRatio: false, animation: noAnim ? false : undefined };

  upsertChart('trend', 'trend-chart', {
    type: 'line',
    data: {
      labels: weekly_completion.map((p) => p.label),
      datasets: [{ data: weekly_completion.map((p) => p.completed), borderColor: '#F38F88', backgroundColor: 'rgba(255,183,178,.16)', fill: true, tension: .38, pointBackgroundColor: '#F38F88', pointRadius: 4, borderWidth: 2.5 }],
    },
    options: { ...common, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } } },
  });

  upsertChart('status', 'status-chart', {
    type: 'doughnut',
    data: { labels: ['Completed', 'Pending', 'Overdue'], datasets: [{ data: [st.completed, st.pending, st.overdue], backgroundColor: ['#A9C9AC', '#C9C3E6', '#E5948E'], borderWidth: 0, hoverOffset: 4 }] },
    options: { ...common, cutout: '72%', plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 7, padding: 16 } } } },
  });

  upsertChart('priority', 'priority-chart', {
    type: 'doughnut',
    data: { labels: ['High', 'Medium', 'Low'], datasets: [{ data: [pr.high, pr.medium, pr.low], backgroundColor: ['#f7a59e', '#f7d999', '#a9c9ac'], borderWidth: 0, hoverOffset: 4 }] },
    options: { ...common, cutout: '72%', plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 7, padding: 16 } } } },
  });

  upsertChart('subject', 'subject-chart', {
    type: 'bar',
    data: { labels: wl.map((i) => i.name), datasets: [{ data: wl.map((i) => i.task_count), backgroundColor: wl.map((i) => i.color), borderRadius: 10, borderSkipped: false, maxBarThickness: 48 }] },
    options: { ...common, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } } },
  });

  const total = weekly_completion.reduce((sum, p) => sum + p.completed, 0);
  $('#trend-total').textContent = `${total} finished`;
}

// ─── Study Insights ───────────────────────────────────────────────────────────
function renderInsights() {
  const analytics = state.analytics;
  if (!analytics) return;
  const { study_insights: ins, subject_workload: wl, summary } = analytics;

  const score = ins.productivity_score;
  $('#productivity-score').textContent = `${score}/100`;
  $('#productivity-fill').style.setProperty('--score', score);
  const label = score >= 80 ? 'Excellent momentum!' : score >= 60 ? 'Good progress.' : score >= 40 ? 'Keep pushing.' : 'Needs attention.';
  $('#productivity-label').textContent = label;

  const busiest = [...wl].sort((a, b) => b.task_count - a.task_count)[0];
  if (busiest) {
    $('#busiest-subject').textContent = busiest.name;
    $('#busiest-subject-sub').textContent = `${busiest.task_count} tasks`;
  } else {
    $('#busiest-subject').textContent = '—';
    $('#busiest-subject-sub').textContent = '';
  }

  $('#week-completed').textContent = ins.tasks_this_week;
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
function renderCalendar() {
  const d = state.calendarDate;
  const year = d.getFullYear();
  const month = d.getMonth();
  $('#cal-month-label').textContent = d.toLocaleDateString([], { month: 'long', year: 'numeric' });

  const taskMap = {};
  state.tasks.forEach((task) => {
    const k = dateKey(new Date(task.due_at));
    (taskMap[k] = taskMap[k] || []).push(task);
  });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(new Date());

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let html = dayNames.map((n) => `<div class="cal-header-day">${n}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const tasks = taskMap[key] || [];
    const cls = [
      'cal-day',
      key === todayKey ? 'today' : '',
      key === state.calendarSelectedDate ? 'selected' : '',
      tasks.some((t) => t.state === 'overdue') ? 'has-overdue' : '',
      tasks.some((t) => t.state === 'urgent') ? 'has-urgent' : '',
    ].filter(Boolean).join(' ');
    const dots = tasks.slice(0, 3).map((t) => `<span class="cal-dot" style="background:${t.subject.color}"></span>`).join('');
    const more = tasks.length > 3 ? `<span class="cal-more">+${tasks.length - 3}</span>` : '';
    html += `<button class="${cls}" data-action="select-cal-day" data-cal-date="${key}">
      <span class="cal-day-num">${day}</span>
      ${tasks.length ? `<div class="cal-dots">${dots}${more}</div>` : ''}
    </button>`;
  }
  $('#calendar-grid').innerHTML = html;
}

function renderCalendarDayTasks(key) {
  const tasks = state.tasks.filter((t) => {
    const td = new Date(t.due_at);
    return dateKey(td) === key;
  });
  const dateObj = new Date(key + 'T00:00:00');
  $('#calendar-selected-date').textContent = dateObj.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  if (!tasks.length) {
    $('#calendar-day-task-list').innerHTML = '<p class="cal-no-tasks">No tasks due on this day.</p>';
  } else {
    $('#calendar-day-task-list').innerHTML = tasks.map((t) => `
      <div class="cal-task-item state-${t.state}">
        <i class="subject-dot" style="background:${t.subject.color}"></i>
        <div class="cal-task-info">
          <strong>${escapeHtml(t.title)}</strong>
          <span>${escapeHtml(t.subject.name)} · ${new Date(t.due_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        </div>
        <span class="priority-badge priority-${t.priority}">${t.priority}</span>
      </div>`).join('');
  }
  $('#calendar-day-panel').hidden = false;
}

// ─── Full render ──────────────────────────────────────────────────────────────
function renderAll() {
  renderSubjects();
  renderTaskGroups();
  renderSummary();
  renderCharts();
  renderInsights();
  renderProcrastination();
  renderCalendar();
}

async function refreshData() {
  try {
    const [subjects, tasks, analytics, procrastination] = await Promise.all([
      api('/api/subjects'),
      api('/api/tasks'),
      api(`/api/analytics/dashboard?timezone=${encodeURIComponent(timezone)}`),
      api('/api/analytics/procrastination'),
    ]);
    state.subjects = subjects;
    state.tasks = tasks;
    state.analytics = analytics;
    state.procrastination = procrastination;
    renderAll();
    setTimeout(checkDeadlines, 1500);
  } catch (err) {
    showToast(`Could not load Zejora: ${err.message}`, 'error');
  }
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function populateSubjectSelect(selectedId) {
  $('#task-subject').innerHTML = state.subjects
    .map((s) => `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
    .join('');
}

function openSubjectModal(subject = null) {
  $('#subject-form').reset();
  $('#subject-error').textContent = '';
  $('#subject-id').value = subject?.id || '';
  $('#subject-name').value = subject?.name || '';
  $('#subject-modal-title').textContent = subject ? 'Edit subject' : 'Add a subject';
  $('#delete-subject-button').hidden = !subject;
  const color = subject?.color || '#FFB7B2';
  const ci = $(`input[name="color"][value="${color}"]`);
  if (ci) ci.checked = true;
  $('#subject-modal').showModal();
  setTimeout(() => $('#subject-name').focus(), 50);
}

function openTaskModal(task = null) {
  if (!state.subjects.length) {
    showToast('Create a subject before adding a task.', 'error');
    openSubjectModal();
    return;
  }
  $('#task-form').reset();
  $('#task-error').textContent = '';
  $('#task-id').value = task?.id || '';
  $('#task-title').value = task?.title || '';
  $('#task-description').value = task?.description || '';
  $('#task-due').value = task ? toDatetimeLocal(task.due_at) : defaultDueTime();
  $('#task-hours').value = task?.estimated_hours ?? '';
  $('#task-modal-title').textContent = task ? 'Edit task' : 'Add a task';
  populateSubjectSelect(task?.subject_id || state.subjects[0].id);
  $(`input[name="priority"][value="${task?.priority || 'medium'}"]`).checked = true;
  $('#task-modal').showModal();
  setTimeout(() => $('#task-title').focus(), 50);
}

function confirmAction({ title, message, acceptLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    $('#confirm-accept').textContent = acceptLabel;
    $('#confirm-accept').className = `button ${danger ? 'button-danger' : 'button-primary'}`;
    const finish = (v) => { modal.close(); resolve(v); };
    $('#confirm-cancel').onclick = () => finish(false);
    $('#confirm-accept').onclick = () => finish(true);
    modal.oncancel = (e) => { e.preventDefault(); finish(false); };
    modal.showModal();
  });
}

// ─── API actions ──────────────────────────────────────────────────────────────
async function saveSubject(event) {
  event.preventDefault();
  const id = $('#subject-id').value;
  const payload = { name: $('#subject-name').value, color: $('input[name="color"]:checked').value };
  try {
    await api(id ? `/api/subjects/${id}` : '/api/subjects', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    $('#subject-modal').close();
    showToast(id ? 'Subject updated.' : 'Subject created.');
    await refreshData();
  } catch (err) {
    $('#subject-error').textContent = err.message;
  }
}

async function saveTask(event) {
  event.preventDefault();
  const id = $('#task-id').value;
  const localDue = $('#task-due').value;
  const dueDate = new Date(localDue);
  if (!localDue || isNaN(dueDate.getTime())) {
    $('#task-error').textContent = 'Choose a valid due date and time.';
    return;
  }
  const h = $('#task-hours').value;
  const payload = {
    title: $('#task-title').value,
    description: $('#task-description').value || null,
    subject_id: Number($('#task-subject').value),
    due_at: dueDate.toISOString(),
    priority: $('input[name="priority"]:checked').value,
    estimated_hours: h ? parseFloat(h) : null,
  };
  try {
    await api(id ? `/api/tasks/${id}` : '/api/tasks', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    $('#task-modal').close();
    showToast(id ? 'Task updated.' : 'Task added.');
    await refreshData();
  } catch (err) {
    $('#task-error').textContent = err.message;
  }
}

async function deleteSubject(subject) {
  const w = subject.task_count === 1 ? 'task' : 'tasks';
  const msg = subject.task_count
    ? `${subject.name} contains ${subject.task_count} ${w}. Deleting it will permanently remove them too.`
    : `Delete ${subject.name}? This cannot be undone.`;
  if (!await confirmAction({ title: `Delete ${subject.name}?`, message: msg })) return;
  try {
    await api(`/api/subjects/${subject.id}?cascade=true`, { method: 'DELETE' });
    $('#subject-modal').close();
    showToast('Subject deleted.');
    await refreshData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function toggleTask(task, completed) {
  try {
    await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ completed }) });
    showToast(completed ? 'Task complete. Nice work.' : 'Task reopened.');
    await refreshData();
  } catch (err) {
    showToast(err.message, 'error');
    await refreshData();
  }
}

async function deleteTask(task) {
  if (!await confirmAction({ title: 'Delete this task?', message: `${task.title} will be permanently removed.` })) return;
  try {
    await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    showToast('Task deleted.');
    await refreshData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function postponeTask(task) {
  try {
    await api(`/api/tasks/${task.id}/postpone`, { method: 'PATCH', body: JSON.stringify({ days: 1 }) });
    showToast('Task postponed by 1 day.');
    await refreshData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Procrastination ──────────────────────────────────────────────────────────
function renderProcrastination() {
  const p = state.procrastination;
  if (!p) return;

  $('#proc-score').textContent = p.procrastination_score;
  $('#proc-score-ring').style.setProperty('--pscore', p.procrastination_score);
  $('#proc-level').textContent = p.productivity_level;
  $('#proc-level').className = `proc-level-badge level-${p.productivity_level.toLowerCase().replace(/\s+/g, '-')}`;
  $('#proc-avg-delay').textContent = p.avg_delay_days.toFixed(1);
  $('#proc-overdue-rate').textContent = `${p.overdue_rate}%`;
  $('#proc-avg-postpone').textContent = p.avg_postpone_count.toFixed(1);

  // Avoided subjects
  const avoidedEl = $('#proc-avoided-list');
  if (p.most_avoided_subjects.length) {
    avoidedEl.innerHTML = p.most_avoided_subjects.map((name) => {
      const subj = state.subjects.find((s) => s.name === name);
      const color = subj?.color || '#ccc';
      return `<li class="proc-avoided-item"><i class="subject-dot" style="background:${color}"></i><span>${escapeHtml(name)}</span></li>`;
    }).join('');
  } else {
    avoidedEl.innerHTML = '<li class="proc-empty">No patterns detected yet.</li>';
  }

  // Recommendations
  const recsEl = $('#proc-recs-list');
  recsEl.innerHTML = p.recommendations.map((r) =>
    `<li class="proc-rec-item"><span class="proc-rec-icon">💡</span><span>${escapeHtml(r)}</span></li>`
  ).join('');

  // Heatmap
  renderHeatmap(p.heatmap);

  // Charts
  if (!window.Chart) return;
  const isDark = document.documentElement.dataset.theme === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  const tickColor = isDark ? '#a09790' : '#78716c';
  const chartDefaults = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: gridColor }, ticks: { color: tickColor, font: { family: 'Outfit', size: 11 } } },
      y: { grid: { color: gridColor }, ticks: { color: tickColor, font: { family: 'Outfit', size: 11 } }, beginAtZero: true },
    },
  };

  // Delay by subject chart
  if (state.charts.procSubject) state.charts.procSubject.destroy();
  const subjectData = p.by_subject.filter((s) => s.total_tasks > 0);
  state.charts.procSubject = new Chart($('#proc-subject-chart'), {
    type: 'bar',
    data: {
      labels: subjectData.map((s) => s.name),
      datasets: [{
        data: subjectData.map((s) => s.avg_delay),
        backgroundColor: subjectData.map((s) => s.color + 'cc'),
        borderColor: subjectData.map((s) => s.color),
        borderWidth: 1.5,
        borderRadius: 6,
      }],
    },
    options: { ...chartDefaults },
  });

  // Delay by priority chart
  if (state.charts.procPriority) state.charts.procPriority.destroy();
  const priColors = { low: '#B8D8BA', medium: '#F4D58D', high: '#FFB7B2' };
  state.charts.procPriority = new Chart($('#proc-priority-chart'), {
    type: 'bar',
    data: {
      labels: p.by_priority.map((x) => x.priority.charAt(0).toUpperCase() + x.priority.slice(1)),
      datasets: [{
        data: p.by_priority.map((x) => x.avg_delay),
        backgroundColor: p.by_priority.map((x) => priColors[x.priority] + 'cc'),
        borderColor: p.by_priority.map((x) => priColors[x.priority]),
        borderWidth: 1.5,
        borderRadius: 6,
      }],
    },
    options: { ...chartDefaults },
  });

  // Weekly delay trend chart
  if (state.charts.procTrend) state.charts.procTrend.destroy();
  const accentColor = isDark ? '#f38f88' : '#f07068';
  state.charts.procTrend = new Chart($('#proc-trend-chart'), {
    type: 'line',
    data: {
      labels: p.weekly_delay_trend.map((x) => x.label),
      datasets: [{
        data: p.weekly_delay_trend.map((x) => x.avg_delay),
        borderColor: accentColor,
        backgroundColor: accentColor + '22',
        tension: 0.4, fill: true, pointRadius: 4,
        pointBackgroundColor: accentColor,
      }],
    },
    options: {
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toFixed(1)} days late` } },
      },
    },
  });
}

function renderHeatmap(cells) {
  const container = $('#heatmap-grid');
  const yLabels = $('#heatmap-y-labels');
  const xLabels = $('#heatmap-x-labels');
  if (!container) return;

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const countMap = {};
  cells.forEach(({ day, hour, count }) => { countMap[`${day}-${hour}`] = count; });
  const maxCount = Math.max(1, ...cells.map((c) => c.count));

  xLabels.innerHTML = days.map((d) => `<span class="heatmap-day-label">${d}</span>`).join('');
  yLabels.innerHTML = hours.map((h) => {
    const label = h % 6 === 0 ? (h === 0 ? '12am' : h === 12 ? '12pm' : `${h > 12 ? h - 12 : h}${h >= 12 ? 'pm' : 'am'}`) : '';
    return `<span class="heatmap-hour-label">${label}</span>`;
  }).join('');

  let html = '';
  hours.forEach((h) => {
    days.forEach((_, d) => {
      const count = countMap[`${d}-${h}`] || 0;
      const intensity = count === 0 ? 0 : Math.ceil((count / maxCount) * 4);
      html += `<div class="heatmap-cell intensity-${intensity}" title="${days[d]} ${h}:00 — ${count} task(s)"></div>`;
    });
  });
  container.innerHTML = html;
}

// ─── Sidebar / nav ────────────────────────────────────────────────────────────
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-scrim').classList.remove('open');
}

function setGreeting() {
  const h = new Date().getHours();
  $('#dashboard-title').textContent = h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
  $('#date-label').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// ─── Event listeners ──────────────────────────────────────────────────────────
document.addEventListener('click', async (event) => {
  const t = event.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  const taskEl = t.closest('[data-task-id]');
  const subjectEl = t.closest('[data-subject-id]');
  const task = taskEl ? state.tasks.find((x) => x.id === Number(taskEl.dataset.taskId)) : null;
  const subject = subjectEl ? state.subjects.find((x) => x.id === Number(subjectEl.dataset.subjectId)) : null;

  if (action === 'add-subject') openSubjectModal();
  if (action === 'add-task') openTaskModal();
  if (action === 'edit-task') openTaskModal(task);
  if (action === 'delete-task') await deleteTask(task);
  if (action === 'toggle-task') await toggleTask(task, t.checked);
  if (action === 'postpone-task') await postponeTask(task);
  if (action === 'filter-subject') {
    state.filterSubject = state.filterSubject === subject.id ? null : subject.id;
    renderSubjects();
    renderTaskGroups();
    closeSidebar();
  }
  if (action === 'edit-subject') openSubjectModal(subject);
  if (action === 'select-cal-day') {
    state.calendarSelectedDate = t.dataset.calDate;
    renderCalendar();
    renderCalendarDayTasks(t.dataset.calDate);
  }
});

$('#subject-form').addEventListener('submit', saveSubject);
$('#task-form').addEventListener('submit', saveTask);
$('#add-subject-button').addEventListener('click', () => openSubjectModal());
$('#header-add-subject').addEventListener('click', () => openSubjectModal());
$('#add-task-button').addEventListener('click', () => openTaskModal());
$('#delete-subject-button').addEventListener('click', () => {
  const s = state.subjects.find((x) => x.id === Number($('#subject-id').value));
  if (s) deleteSubject(s);
});
$('#open-sidebar').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#sidebar-scrim').classList.add('open'); });
$('#close-sidebar').addEventListener('click', closeSidebar);
$('#sidebar-scrim').addEventListener('click', closeSidebar);
$$('[data-close-dialog]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));
$$('[data-scroll]').forEach((btn) => btn.addEventListener('click', () => {
  $(`#${btn.dataset.scroll}-section`).scrollIntoView({ behavior: 'smooth' });
  closeSidebar();
}));
$('.nav-item[data-view="all"]').addEventListener('click', () => {
  state.filterSubject = null;
  renderSubjects();
  renderTaskGroups();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  closeSidebar();
});
$('.nav-item[data-view="calendar"]').addEventListener('click', () => {
  $('#calendar-section').scrollIntoView({ behavior: 'smooth' });
  closeSidebar();
});

// Dark mode
$('#dark-mode-toggle').addEventListener('click', toggleDarkMode);
$('#header-dark-mode').addEventListener('click', toggleDarkMode);

// Notifications
$('#notification-toggle').addEventListener('click', async () => {
  await requestNotificationPermission();
  loadReminderForm();
  $('#reminder-modal').showModal();
});
$('#reminder-settings-btn').addEventListener('click', () => {
  loadReminderForm();
  $('#reminder-modal').showModal();
});
$('#save-reminders').addEventListener('click', saveReminderSettings);

// Search & filter
$('#search-input').addEventListener('input', (e) => {
  state.searchQuery = e.target.value.trim();
  renderTaskGroups();
});
$$('[data-filter-status]').forEach((btn) => btn.addEventListener('click', () => {
  $$('[data-filter-status]').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.filterStatus = btn.dataset.filterStatus;
  renderTaskGroups();
}));
$$('[data-filter-priority]').forEach((btn) => btn.addEventListener('click', () => {
  $$('[data-filter-priority]').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.filterPriority = btn.dataset.filterPriority;
  renderTaskGroups();
}));

// Calendar nav
$('#cal-prev').addEventListener('click', () => {
  const d = state.calendarDate;
  state.calendarDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  state.calendarSelectedDate = null;
  $('#calendar-day-panel').hidden = true;
  renderCalendar();
});
$('#cal-next').addEventListener('click', () => {
  const d = state.calendarDate;
  state.calendarDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  state.calendarSelectedDate = null;
  $('#calendar-day-panel').hidden = true;
  renderCalendar();
});
$('#close-calendar-panel').addEventListener('click', () => {
  $('#calendar-day-panel').hidden = true;
  state.calendarSelectedDate = null;
  renderCalendar();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
initTheme();
setGreeting();
chartDefaults();
initNotifications();
refreshData();
