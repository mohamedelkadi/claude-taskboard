'use strict';
// Shared state, helpers and the event plumbing every view uses.

const S = {
  data: null,
  view: 'board', // board | needs | sessions | graph
  q: '',
  project: '',
  cardId: null, // card open in the drawer
  expanded: new Set(), // sub-tasks unfolded in the drawer
  details: new Map(), // session id -> transcript detail
  showDoneSubs: false,
  showAuto: false,
  editDesc: false,
  editSub: null,
  inbox: true,
  composer: null, // column id with the "new card" box open
  sel: new Set(), // sessions ticked in the Sessions view
  sessScope: 'unsorted', // unsorted | linked | all
  sessState: '',
  showArchived: false,
  graph: { sessions: false, hideDone: true },
  drag: null,
  swapping: false,
  pointerDown: false,
  renderPending: false,
  connected: true,
};

const ACTIONS = {}; // click handlers, by data-act
const CHANGES = {}; // change handlers for selects and checkboxes, by data-change
const COMMITS = {}; // text fields saved on blur / Enter, by data-commit

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

const STATE_LABEL = { running: 'Running', needs_you: 'Needs you', review: 'Ready for review', done: 'Done', idle: 'Idle' };
const SUB_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', review: 'In review', done: 'Done' };
const PRIO_LABEL = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
const byRecent = (a, b) => b.lastActivityAt - a.lastActivityAt;

// ---------- derived lookups, rebuilt when the data changes ----------

let IX = null;
function ix() {
  const d = S.data;
  if (IX && IX.v === d.version) return IX;
  const latestRun = new Set(d.routines.map((r) => r.latestId));
  // every run of a scheduled task counts as one session: its latest run
  const visible = d.sessions.filter((s) => !s.routineId || latestRun.has(s.id));
  const names = new Set();
  for (const s of d.sessions) if (!s.archived && s.projectName) names.add(s.projectName);
  for (const c of d.cards) if (c.project) names.add(c.project);
  IX = {
    v: d.version,
    sessions: new Map(d.sessions.map((s) => [s.id, s])),
    cards: new Map(d.cards.map((c) => [c.id, c])),
    cols: new Map(d.columns.map((c) => [c.id, c])),
    routines: new Map(d.routines.map((r) => [r.id, r])),
    visible,
    unsorted: visible.filter((s) => !s.cardId && !s.archived && !s.hidden).sort(byRecent),
    needs: visible.filter((s) => s.estate === 'needs_you' && !s.archived).sort(byRecent),
    review: visible.filter((s) => s.estate === 'review' && !s.archived).sort(byRecent),
    projects: [...names].sort((a, b) => a.localeCompare(b)),
  };
  return IX;
}

const colName = (id) => (ix().cols.get(id) || { name: id }).name;

// ---------- formatting ----------

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fullDate(ms) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function hue(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const projChip = (name) => (name ? `<span class="chip proj" style="--h:${hue(name)}" title="Project">${esc(name)}</span>` : '');

function ticketChip(key) {
  if (!key) return '';
  const tpl = S.data.settings.ticketUrl;
  if (tpl && /^https?:\/\//.test(tpl)) {
    return `<a class="chip ticket" href="${esc(tpl.replace('{key}', encodeURIComponent(key)))}" target="_blank" rel="noopener" data-stop>${esc(key)}</a>`;
  }
  return `<span class="chip ticket">${esc(key)}</span>`;
}

function prChip(pr) {
  const st = (pr.state || '').toLowerCase();
  const cls = st === 'merged' ? 'pr-merged' : st === 'closed' ? 'pr-closed' : st === 'open' ? 'pr-open' : '';
  const label = `#${pr.number}${st === 'merged' ? ' ✓' : st === 'closed' ? ' ✕' : ''}`;
  const title = `${pr.repo}#${pr.number}${st ? ' · ' + st : ''}${pr.branch ? ' · ' + pr.branch : ''}`;
  return /^https:\/\//.test(pr.url || '')
    ? `<a class="chip ${cls}" href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(title)}" data-stop>${esc(label)}</a>`
    : `<span class="chip ${cls}" title="${esc(title)}">${esc(label)}</span>`;
}

const stateChip = (state) => `<span class="state-chip ${esc(state)}">${esc(STATE_LABEL[state] || state)}</span>`;
const stateDot = (state) => `<span class="state-dot ${esc(state)}" title="${esc(STATE_LABEL[state] || '')}"></span>`;

/** A small, safe subset of Markdown: paragraphs, bullets, bold, code, links. */
function md(text) {
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = [];
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
    if (list) out.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (para.length) flush();
      (list = list || []).push(bullet[1]);
    } else if (!line.trim()) flush();
    else {
      if (list) flush();
      para.push(line.replace(/^#{1,4}\s+/, ''));
    }
  }
  flush();
  return out.join('');
}

function matches(text) {
  const q = S.q.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

function cardMatches(card) {
  if (S.project && card.project !== S.project && !card.view.subs.some((sub) => (ix().sessions.get(sub.sessionId) || {}).projectName === S.project)) return false;
  if (!S.q.trim()) return true;
  return matches([card.key, card.title, card.ticket, card.project, card.tags.join(' '), card.view.subs.map((s) => s.title).join(' '), card.view.tickets.join(' ')].join(' '));
}

function sessionMatches(s) {
  if (S.project && s.projectName !== S.project) return false;
  if (!S.q.trim()) return true;
  return matches([s.title, s.projectName, s.branch, s.tickets.join(' '), s.prs.map((p) => '#' + p.number).join(' '), (s.summary && s.summary.needsAction) || ''].join(' '));
}

// ---------- talking to the server ----------

function toast(text, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2600);
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}

/** Run one board operation; the server answers with the fresh state. */
async function op(name, args) {
  try {
    const j = await post('/api/op', { name, args });
    if (!j.ok) {
      toast(j.error || 'That did not work.', 'error');
      return null;
    }
    setData(j.state);
    return j.result == null ? true : j.result;
  } catch (_) {
    toast('The board server is not responding. Run "taskboard start".', 'error');
    return null;
  }
}

async function loadState() {
  const res = await fetch('/api/state');
  setData(await res.json());
}

function setData(d) {
  if (!d || !d.columns) return;
  S.data = d;
  IX = null;
  if (S.cardId && !ix().cards.has(S.cardId)) S.cardId = null;
  for (const id of [...S.sel]) if (!ix().sessions.has(id)) S.sel.delete(id);
  renderWhenSafe();
}

/**
 * Repaint now, unless a drag or a click is in flight. Replacing the page
 * between mouse-down and mouse-up would swallow the click, which happens when
 * a field saves on blur because the user clicked a button.
 */
function renderWhenSafe() {
  if (S.drag) S.drag.stale = true;
  else if (S.pointerDown) S.renderPending = true;
  else render();
}

async function openSession(id) {
  const s = ix().sessions.get(id);
  if (!s) return;
  if (s.source === 'cli') {
    await copyText(`claude --resume ${s.cliId}`);
    return toast('This one ran in a terminal. Resume command copied.');
  }
  const j = await post('/api/open', { sessionId: id }).catch(() => null);
  if (!j || !j.ok) toast((j && j.error) || 'Could not open the Claude app.', 'error');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ---------- rendering ----------

/**
 * Replace a region's HTML without losing what the user is doing in it:
 * scroll positions and the focused field (with its unsaved text) survive.
 */
function swap(root, html) {
  const active = document.activeElement;
  const keep =
    active && root.contains(active) && active.dataset.keep
      ? { key: active.dataset.keep, value: active.value, s: active.selectionStart, e: active.selectionEnd }
      : null;
  const scroll = $$('[data-scroll]', root).map((el) => [el.dataset.scroll, el.scrollTop, el.scrollLeft]);
  S.swapping = true;
  root.innerHTML = html;
  S.swapping = false;
  for (const [key, top, left] of scroll) {
    const el = root.querySelector(`[data-scroll="${CSS.escape(key)}"]`);
    if (el) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }
  if (keep) {
    const el = root.querySelector(`[data-keep="${CSS.escape(keep.key)}"]`);
    if (el) {
      if (el.tagName !== 'SELECT') el.value = keep.value;
      el.focus({ preventScroll: true });
      try {
        el.setSelectionRange(keep.s, keep.e);
      } catch (_) {}
    }
  }
}

function renderTop() {
  const top = $('#top');
  if (!top.dataset.built) {
    top.dataset.built = '1';
    top.innerHTML = `
      <div class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#d97757"/><rect x="6" y="7" width="5.5" height="18" rx="1.5" fill="#fff"/><rect x="13.25" y="7" width="5.5" height="12" rx="1.5" fill="#fff" opacity=".85"/><rect x="20.5" y="7" width="5.5" height="8" rx="1.5" fill="#fff" opacity=".7"/></svg><span>Taskboard</span></div>
      <nav class="tabs">
        <button class="tab" data-act="view" data-view="board">Board</button>
        <button class="tab" data-act="view" data-view="needs">Needs me <span class="pill needs" id="n-needs"></span></button>
        <button class="tab" data-act="view" data-view="sessions">Sessions <span class="pill" id="n-unsorted" title="Open sessions that are not on a card"></span></button>
        <button class="tab" data-act="view" data-view="graph">Connections</button>
      </nav>
      <div class="grow"></div>
      <span class="conn-lost" id="conn-lost" hidden>Board server not reachable</span>
      <input class="search" id="q" type="search" placeholder="Search cards and sessions  /" autocomplete="off">
      <select class="field" id="project" data-change="project" title="Project"></select>
      <button class="btn primary" data-act="new-card">New card</button>
      <button class="icon-btn" data-act="theme" title="Switch light / dark">◐</button>
      <button class="icon-btn" data-act="settings" title="Settings">⚙</button>`;
  }
  const x = ix();
  for (const tab of $$('.tab', top)) tab.classList.toggle('on', tab.dataset.view === S.view);
  const needs = $('#n-needs');
  needs.textContent = x.needs.length || '';
  needs.hidden = !x.needs.length;
  const uns = $('#n-unsorted');
  uns.textContent = x.unsorted.length || '';
  uns.hidden = !x.unsorted.length;
  const sel = $('#project');
  const options = `<option value="">All projects</option>${x.projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}`;
  if (sel.dataset.sig !== options) {
    sel.dataset.sig = options;
    sel.innerHTML = options;
  }
  sel.value = x.projects.includes(S.project) ? S.project : '';
  $('#conn-lost').hidden = S.connected;
}

function renderMain() {
  const main = $('#main');
  if (S.view === 'needs') return swap(main, renderNeeds());
  if (S.view === 'sessions') return swap(main, renderSessions());
  if (S.view === 'graph') return renderGraph(main);
  return swap(main, renderBoard());
}

function render() {
  if (!S.data) return;
  renderTop();
  renderMain();
  renderDrawer();
  refreshSessionModal();
}

function setHash() {
  const card = S.cardId && ix().cards.get(S.cardId);
  const h = card ? `card=${card.key}` : S.view === 'board' ? '' : S.view;
  if (location.hash.replace(/^#/, '') !== h) history.replaceState(null, '', h ? `#${h}` : location.pathname);
}

function readHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  const m = /^card=(.+)$/.exec(h);
  if (m && S.data) {
    const card = S.data.cards.find((c) => c.key.toLowerCase() === m[1].toLowerCase() || c.id === m[1]);
    if (card) S.cardId = card.id;
  } else if (['needs', 'sessions', 'graph', 'board'].includes(h)) {
    // the Mac app's menus navigate this way
    S.view = h;
    S.cardId = null;
  }
}

function openCard(id) {
  if (S.cardId !== id) {
    S.expanded.clear();
    S.editDesc = false;
    S.editSub = null;
    S.showDoneSubs = false;
    S.showAuto = false;
  }
  S.cardId = id;
  setHash();
  render();
}

function closeCard() {
  S.cardId = null;
  setHash();
  render();
}

// ---------- shared actions ----------

ACTIONS.view = (el) => {
  S.view = el.dataset.view;
  setHash();
  render();
};
ACTIONS.theme = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('tb-theme', root.dataset.theme);
  } catch (_) {}
};
ACTIONS['open-card'] = (el) => openCard(el.dataset.card);
ACTIONS['close-card'] = () => closeCard();
ACTIONS['open-session'] = (el) => openSession(el.dataset.session);
ACTIONS['session-info'] = (el) => sessionModal(el.dataset.session);
ACTIONS.ack = async (el) => {
  const s = ix().sessions.get(el.dataset.session);
  if (s && (await op('session.meta', { sessionIds: [s.id], ack: { [s.id]: s.token } }))) toast('Marked as handled. It comes back if the session asks again.');
};
CHANGES.project = (el) => {
  S.project = el.value;
  render();
};
