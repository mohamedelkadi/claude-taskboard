'use strict';
// The Diary view: one day of work at a time, a calendar to move between days,
// and a search over every day. The data comes from /api/diary, not from the
// board state, because it reaches back further than Claude's own sessions do.

const DIARY_KIND = { p: 'You', a: 'Claude', r: 'Recap', s: 'Done', c: 'Commit', pr: 'PR', f: 'Files' };
const DIARY_FOLD = 8; // rows of a session shown before "Show all"

const diaryWant = () => `${S.diary.day}|${S.q.trim()}|${S.project}`;

/** Fetch what the view needs. Typing in the search box waits a moment first. */
function loadDiary(now) {
  const D = S.diary;
  const want = diaryWant();
  const ask = `${want}|${D.latest}`;
  if (D.pending === ask) return; // already on its way
  D.pending = ask;
  clearTimeout(D.timer);
  D.timer = setTimeout(async () => {
    const id = ++D.req;
    let j = null;
    try {
      const res = await fetch('/api/diary?' + new URLSearchParams({ day: D.day, q: S.q.trim(), project: S.project }));
      j = await res.json();
    } catch (_) {}
    if (id !== D.req) return; // a newer request is on its way
    D.pending = '';
    D.asked = ask;
    if (j && j.ok) {
      D.data = j;
      D.key = want;
      D.v = j.v;
      if (j.v > D.latest) D.latest = j.v;
    }
    if (S.view === 'diary') renderMain();
  }, now ? 0 : 220);
}

const dayDate = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayLong = (day) => dayDate(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dayShort = (day) => dayDate(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
// a log reads best on a 24-hour clock, whatever the locale's habit
const hm = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const count = (n, word) => `${n} ${word}${n === 1 ? '' : /ch$/.test(word) ? 'es' : 's'}`;

function daysAgo(day, today) {
  const n = Math.round((dayDate(today) - dayDate(day)) / 864e5);
  return n === 0 ? 'Today' : n === 1 ? 'Yesterday' : n > 1 && n < 7 ? `${n} days ago` : '';
}

function fileSize(bytes) {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

/** Escaped text with the search words marked. */
function marked(text, terms) {
  const words = (terms || []).filter(Boolean).sort((a, b) => b.length - a.length).map((t) => t.replace(/[^\p{L}\p{N}\s]/gu, '\\$&'));
  if (!words.length) return esc(text);
  const re = new RegExp('(' + words.join('|') + ')', 'gi');
  return String(text).split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

// ---------- the calendar ----------

function weekStart() {
  try {
    const loc = new Intl.Locale(navigator.language);
    const info = loc.weekInfo || (loc.getWeekInfo && loc.getWeekInfo());
    if (info && info.firstDay) return info.firstDay % 7; // 7 is Sunday there, 0 here
  } catch (_) {}
  return 1;
}

function diaryCalendar(d, shown) {
  const month = S.diary.month || (shown || d.today).slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const start = weekStart();
  const lead = (new Date(y, m - 1, 1).getDay() - start + 7) % 7;
  const inMonth = new Date(y, m, 0).getDate();
  const byDay = new Map(d.days.map((x) => [x[0], x]));
  const hits = d.results ? new Map(d.results.days) : null;
  const names = [];
  for (let i = 0; i < 7; i++) names.push(new Date(2024, 0, 7 + start + i).toLocaleDateString(undefined, { weekday: 'narrow' })); // 7 Jan 2024 was a Sunday
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span></span>');
  for (let n = 1; n <= inMonth; n++) {
    const day = `${month}-${String(n).padStart(2, '0')}`;
    const info = byDay.get(day);
    const sessions = info ? info[1] : 0;
    const level = !info ? 0 : sessions >= 9 ? 4 : sessions >= 5 ? 3 : sessions >= 2 ? 2 : 1;
    const cls = ['cal-day', `lv${level}`, day === shown ? 'on' : '', day === d.today ? 'today' : '', hits ? (hits.has(day) ? 'hit' : 'miss') : ''].filter(Boolean).join(' ');
    const title = hits && hits.has(day) ? count(hits.get(day), 'match') : info ? `${count(sessions, 'session')} · ${count(info[2], 'prompt')}` : 'Nothing recorded';
    cells.push(`<button class="${cls}" data-act="diary-day" data-day="${day}" title="${esc(title)}">${n}</button>`);
  }
  const first = d.days.length ? d.days[d.days.length - 1][0].slice(0, 7) : month;
  const last = d.today.slice(0, 7);
  const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const step = (n) => dayKey(new Date(y, m - 1 + n, 1)).slice(0, 7);
  return `
    <div class="cal">
      <div class="cal-head">
        <button class="icon-btn" data-act="diary-month" data-month="${step(-1)}" title="Earlier month" ${month <= first ? 'disabled' : ''}>‹</button>
        <span class="cal-month">${esc(label)}</span>
        <button class="icon-btn" data-act="diary-month" data-month="${step(1)}" title="Later month" ${month >= last ? 'disabled' : ''}>›</button>
      </div>
      <div class="cal-grid">${names.map((n) => `<span class="cal-dow">${esc(n)}</span>`).join('')}${cells.join('')}</div>
    </div>`;
}

function diaryRail(d, shown) {
  const reading = d.progress && d.progress.left > 0;
  const recent = d.days.slice(0, 60);
  const hits = d.results ? new Map(d.results.days) : null;
  const rows = (hits ? d.results.days : recent).slice(0, 60).map((x) => {
    const day = x[0];
    const info = hits ? `${x[1]}` : `${x[1]}`;
    return `<button class="day-row${day === shown ? ' on' : ''}" data-act="diary-day" data-day="${day}">
      <span class="day-name">${esc(daysAgo(day, d.today) || dayShort(day))}</span>
      <span class="pill" title="${hits ? 'Matches' : 'Sessions'}">${info}</span></button>`;
  });
  return `
    <aside class="diary-rail" data-scroll="diary-rail">
      ${diaryCalendar(d, shown)}
      <div class="rail-head">${hits ? 'Days with matches' : 'Recent days'}</div>
      <div class="day-list">${rows.join('') || '<div class="inbox-empty">Nothing yet.</div>'}</div>
      <div class="rail-foot" title="The diary keeps short notes per day, not copies of your sessions.">
        ${reading ? `Reading your Claude history… ${d.progress.left} of ${d.progress.total} sessions to go` : `${count(d.stats.days, 'day')} kept · ${fileSize(d.stats.bytes)} on disk`}
      </div>
    </aside>`;
}

// ---------- one day ----------

function diaryRows(s) {
  // steps finished in a row read as one line; edited files as one line at the end
  const rows = [];
  const files = [];
  for (const e of s.entries) {
    if (e.k === 'o') continue;
    if (e.k === 'f') {
      files.push(e.x);
      continue;
    }
    const prev = rows[rows.length - 1];
    if (e.k === 's' && prev && prev.k === 's') prev.list.push(e.x);
    else rows.push(e.k === 's' ? { t: e.t, k: 's', list: [e.x] } : e);
  }
  if (files.length) rows.push({ t: 0, k: 'f', list: files });
  return rows;
}

function diaryRow(s, e, i, terms) {
  const id = `${s.id}|${i}`;
  const wide = S.diary.wide.has(id);
  let body;
  if (e.k === 's') body = `<div class="dx steps-done">${e.list.map((x) => `<span>✓ ${marked(x, terms)}</span>`).join('')}</div>`;
  else if (e.k === 'f') {
    const names = e.list.map((f) => `<code title="${esc(f)}">${marked(f.split('/').pop(), terms)}</code>`);
    const shown = wide ? names : names.slice(0, 8);
    body = `<div class="dx files">${shown.join(' ')}${names.length > shown.length ? ` <button class="fold" data-act="diary-wide" data-id="${esc(id)}">+${names.length - shown.length} more</button>` : ''}</div>`;
  } else if (e.k === 'pr') {
    const label = `${e.repo ? e.repo.split('/').pop() : ''} #${e.n}`;
    const link = /^https:\/\//.test(e.url || '') ? `<a class="chip pr-open" href="${esc(e.url)}" target="_blank" rel="noopener" data-stop>${esc(label)}</a>` : `<span class="chip">${esc(label)}</span>`;
    body = `<div class="dx">${link} ${marked(e.x, terms)}</div>`;
  } else {
    const long = e.x.length > 260 || e.x.split('\n').length > 3;
    body = `<div class="dx${long && !wide ? ' clamp' : ''}"${long ? ` data-act="diary-wide" data-id="${esc(id)}" title="${wide ? 'Show less' : 'Show all of it'}"` : ''}>${marked(e.x, terms)}</div>`;
  }
  return `<li class="dl k-${e.k}"><time>${e.t ? hm(e.t) : ''}</time><span class="dk">${DIARY_KIND[e.k] || ''}</span>${body}</li>`;
}

function diarySessionHead(s, terms) {
  const span = hm(s.first) === hm(s.last) ? hm(s.first) : `${hm(s.first)} – ${hm(s.last)}`;
  const title = s.exists
    ? `<span class="dsess-title link" data-act="session-info" data-session="${esc(s.id)}">${marked(s.title, terms)}</span>`
    : `<span class="dsess-title">${marked(s.title, terms)}</span>`;
  const card = s.card
    ? s.card.id
      ? `<a class="chip" href="#card=${esc(s.card.key)}" data-act="open-card" data-card="${esc(s.card.id)}" title="${esc(s.card.title)}">${esc(s.card.key)} ${esc(s.card.title)}</a>`
      : `<span class="chip" title="This card is no longer on the board">${esc(s.card.key)} ${esc(s.card.title)}</span>`
    : '';
  const flag = !s.exists
    ? '<span class="chip tag" title="Claude no longer has this session. The diary kept these notes.">No longer in Claude</span>'
    : s.archived
      ? '<span class="chip tag">Archived</span>'
      : '';
  return `
    <header class="dsess-head">
      <span class="dtime">${esc(span)}</span>
      ${title}
      ${projChip(s.projectName)} ${card} ${flag} ${(s.prs || []).map(prChip).join(' ')}
      <span class="grow"></span>
      ${s.exists ? `<button class="icon-btn" data-act="open-session" data-session="${esc(s.id)}" title="${s.source === 'cli' ? 'Copy the command that resumes it' : 'Open in Claude'}">↗</button>` : ''}
    </header>`;
}

function diarySession(s) {
  const rows = diaryRows(s);
  const open = S.diary.open.has(s.id);
  const shown = open ? rows : rows.slice(0, DIARY_FOLD);
  return `
    <section class="dsess">
      ${diarySessionHead(s)}
      ${rows.length ? `<ol class="dlog">${shown.map((e, i) => diaryRow(s, e, i)).join('')}</ol>` : '<div class="dnone">The session was open. Its transcript was already gone, so there is nothing more to show.</div>'}
      ${rows.length > DIARY_FOLD ? `<button class="fold" data-act="diary-open" data-id="${esc(s.id)}">${open ? 'Show less' : `Show all ${rows.length} entries`}</button>` : ''}
    </section>`;
}

function diaryDay(d) {
  const p = d.day;
  const t = p.totals;
  const rel = daysAgo(p.day, d.today);
  const facts = [count(t.sessions, 'session'), count(t.prompts, 'prompt')];
  if (t.steps) facts.push(count(t.steps, 'step') + ' done');
  if (t.commits) facts.push(count(t.commits, 'commit'));
  if (t.prs) facts.push(count(t.prs, 'PR'));
  if (t.files) facts.push(count(t.files, 'file') + ' edited');
  return `
    <div class="diary-head">
      <button class="btn small" data-act="diary-day" data-day="${esc(p.prev)}" title="The day before with something in it" ${p.prev ? '' : 'disabled'}>‹</button>
      <h1>${esc(dayLong(p.day))}</h1>
      ${rel ? `<span class="pill">${rel}</span>` : ''}
      <button class="btn small" data-act="diary-day" data-day="${esc(p.next)}" title="The next day with something in it" ${p.next ? '' : 'disabled'}>›</button>
      <span class="grow"></span>
      <input class="field day-pick" type="date" data-change="diary-pick" value="${esc(p.day)}" max="${esc(d.today)}" title="Go to a date">
      ${p.day !== d.today ? '<button class="btn small" data-act="diary-day" data-day="">Latest</button>' : ''}
    </div>
    ${t.sessions ? `<div class="diary-facts">${facts.map((f) => `<span>${f}</span>`).join('')}<span class="muted">${hm(t.first)} – ${hm(t.last)}</span>${t.projects.map(projChip).join('')}</div>` : ''}
    <textarea class="field day-note" data-commit="diary-note" data-day="${esc(p.day)}" data-keep="diary-note-${esc(p.day)}" rows="${Math.min(8, Math.max(1, p.note.split('\n').length))}" placeholder="Your own note for this day…">${esc(p.note)}</textarea>
    ${p.sessions.map(diarySession).join('') || `<div class="empty-state">${S.project ? `Nothing recorded for ${esc(S.project)} on this day.` : 'Nothing recorded on this day.'}</div>`}`;
}

// ---------- search results ----------

function diaryResults(d) {
  const r = d.results;
  if (!r.total) return `<h2>Nothing in the diary matches “${esc(r.q)}”</h2><div class="empty-state">The diary searches what you asked, what Claude reported back, commits, pull requests, file names and your notes.</div>`;
  const out = [`<h2>${count(r.total, 'match')} for “${esc(r.q)}” <span class="muted">on ${count(r.days.length, 'day')}</span></h2>`];
  let day = '';
  for (const it of r.items) {
    if (it.day !== day) {
      day = it.day;
      out.push(`<div class="res-day" data-act="diary-day" data-day="${esc(day)}" title="Open this day">${esc(dayLong(day))}${daysAgo(day, d.today) ? ` <span class="pill">${daysAgo(day, d.today)}</span>` : ''}</div>`);
    }
    if (it.note) {
      out.push(`<section class="dsess"><ol class="dlog"><li class="dl k-n"><time></time><span class="dk">Note</span><div class="dx">${marked(it.note, r.terms)}</div></li></ol></section>`);
      continue;
    }
    const s = { ...it, entries: it.hits };
    const rows = diaryRows(s);
    out.push(`
      <section class="dsess">
        ${diarySessionHead(s, r.terms)}
        <ol class="dlog">${rows.map((e, i) => diaryRow({ id: `${it.day}|${it.id}` }, e, i, r.terms)).join('')}</ol>
        ${it.more ? `<div class="dnone">and ${it.more} more that day</div>` : ''}
      </section>`);
  }
  if (r.total > r.items.length) out.push(`<div class="dnone">Showing the ${r.items.length} most recent. Add a word to narrow it down.</div>`);
  return out.join('');
}

function renderDiary() {
  const D = S.diary;
  const want = diaryWant();
  const stale = !D.data || D.key !== want || D.latest > D.v;
  // each thing is asked for once, so a request that failed is not repeated forever
  if (stale && D.asked !== `${want}|${D.latest}`) loadDiary(!D.data || D.key === want);
  if (!D.data) {
    return D.asked
      ? '<div class="loading">The diary did not answer. <button class="btn small" data-act="diary-retry">Try again</button></div>'
      : '<div class="loading">Opening the diary…</div>';
  }
  const d = D.data;
  const shown = d.day ? d.day.day : '';
  return `
    <div class="diary">
      ${diaryRail(d, shown)}
      <div class="page" data-scroll="diary-${esc(shown || 'search')}">
        <div class="page-inner diary-inner">${d.results ? diaryResults(d) : diaryDay(d)}</div>
      </div>
    </div>`;
}

// ---------- actions ----------

function diaryGo(day) {
  S.diary.day = day;
  S.diary.month = '';
  S.diary.open.clear();
  S.diary.wide.clear();
  if (S.q) {
    // picking a day leaves the search
    S.q = '';
    const box = $('#q');
    if (box) box.value = '';
  }
  setHash();
  loadDiary(true);
}

/** The day before or after the one shown that has something in it (the arrow keys). */
function diaryStep(n) {
  const p = S.diary.data && S.diary.data.day;
  const day = p && (n < 0 ? p.prev : p.next);
  if (day) diaryGo(day);
}

ACTIONS['diary-day'] = (el) => diaryGo(el.dataset.day || '');
ACTIONS['diary-retry'] = () => {
  S.diary.asked = '';
  renderMain();
};
ACTIONS['diary-month'] = (el) => {
  S.diary.month = el.dataset.month;
  renderMain();
};
ACTIONS['diary-open'] = (el) => {
  const set = S.diary.open;
  if (!set.delete(el.dataset.id)) set.add(el.dataset.id);
  renderMain();
};
ACTIONS['diary-wide'] = (el) => {
  if (String(getSelection())) return; // selecting text is not a click
  const set = S.diary.wide;
  if (!set.delete(el.dataset.id)) set.add(el.dataset.id);
  renderMain();
};
CHANGES['diary-pick'] = (el) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(el.value)) diaryGo(el.value);
};
COMMITS['diary-note'] = async (el) => {
  const p = S.diary.data && S.diary.data.day;
  if (!p || p.day !== el.dataset.day || el.value.trim() === p.note) return;
  p.note = el.value.trim(); // the reply is the board; the diary follows through the event stream
  await op('diary.note', { day: el.dataset.day, text: el.value });
};
