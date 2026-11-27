'use strict';
// Workflows on a card: saved prompts the board runs on its own with `claude -p`,
// by hand or on a schedule, on the Claude login of this Mac. The card panel lists
// them with their latest run; a dialog edits one; another follows a run's log.

const WF_ACCESS = {
  read: { label: 'Read and report', short: 'Read only', text: 'Reads files and runs only the commands your Claude settings already allow. It cannot change anything. The safe place to start.' },
  edit: { label: 'Edit files', short: 'Edits files', text: 'Also creates and edits files in its folder. Other commands still have to be allowed in your Claude settings, or they are skipped.' },
  full: { label: 'Anything', short: 'Anything', text: 'Runs any command and edits anything without asking. Only for prompts and folders you trust completely.' },
};
const RUN_LABEL = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed', timeout: 'Timed out', stopped: 'Stopped', interrupted: 'Interrupted' };
const RUN_CLASS = { running: 'running', succeeded: 'done', failed: 'failed', timeout: 'failed', interrupted: 'failed', stopped: 'idle' };
const TRIGGER_LABEL = { manual: 'by hand', schedule: 'on schedule', claude: 'by Claude' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STARTERS = [
  { name: 'Morning summary', prompt: 'Look at what changed in this repository since yesterday (git log, open branches) and write a short summary of what moved and what looks stuck.' },
  { name: 'Run the tests', prompt: 'Run the test suite. If anything fails, find the likely cause and report it, with the failing test names and the files involved. Do not change any code.' },
  { name: 'Check the pull request', prompt: 'Find the open pull request for the current branch with `gh pr view`. Report its CI status, any failing checks with the reason, and review comments that still need an answer.' },
  { name: 'Run a saved workflow', prompt: 'Run the saved workflow named "<name>" with the Workflow tool, then report what it found.' },
];

S.wfOpen = new Set(); // workflows unfolded to show their runs

// a running workflow's clock moves on its own, without repainting anything else
setInterval(() => {
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = duration(Date.now() - Number(el.dataset.since));
}, 1000);

const runChip = (r) => `<span class="state-chip ${RUN_CLASS[r.status] || 'idle'}">${r.status === 'running' ? '<i class="spin"></i>' : ''}${esc(RUN_LABEL[r.status] || r.status)}</span>`;

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** "in 3h", "tomorrow 09:00", for when a schedule fires next. */
function whenNext(ms) {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 60e3) return 'any moment';
  const at = new Date(ms);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d < 12 * 3600e3) return d < 3600e3 ? `in ${Math.round(d / 60e3)}m` : `in ${Math.round(d / 3600e3)}h (${time})`;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "5m ago", "just now", "Nov 3". */
function agoText(ms) {
  const a = ago(ms);
  return a === 'now' ? 'just now' : /^\d+[mhd]$/.test(a) ? `${a} ago` : a;
}

function runLine(r) {
  if (r.status === 'running') {
    return `<div class="wf-live"><span data-since="${r.startedAt}">${esc(duration(Date.now() - r.startedAt))}</span>${r.tools ? `<span>${r.tools} step${r.tools === 1 ? '' : 's'}</span>` : ''}<span class="wf-act" title="${esc(r.activity)}">${esc(r.activity || 'Working…')}</span></div>`;
  }
  const bits = [`<span title="${esc(fullDate(r.startedAt))}">${esc(agoText(r.endedAt || r.startedAt))}</span>`, esc(TRIGGER_LABEL[r.trigger] || '')];
  if (r.endedAt) bits.push(esc(duration(r.endedAt - r.startedAt)));
  if (r.tools) bits.push(`${r.tools} step${r.tools === 1 ? '' : 's'}`);
  if (r.denied) bits.push(`<span class="wf-denied" title="What it may do does not cover these. Pick “Edit files”, or allow the commands in your Claude settings, if it needs them.">${r.denied} not allowed</span>`);
  return `<div class="wf-when">${bits.filter(Boolean).join(' · ')}</div>`;
}

function workflowRow(card, wf, v, onPage) {
  const open = S.wfOpen.has(wf.id);
  const last = v.last;
  const runs = (card.runs || []).filter((r) => r.workflowId === wf.id).sort((a, b) => b.startedAt - a.startedAt);
  const scheduled = wf.schedule && wf.schedule.kind !== 'manual';
  const meta = [
    `<span title="Schedule">${scheduled ? '⏰ ' : ''}${esc(v.schedule)}</span>`,
    scheduled && !wf.enabled ? '<span class="wf-paused">paused</span>' : '',
    v.nextAt && !v.running ? `<span title="${esc(fullDate(v.nextAt))}">next ${esc(whenNext(v.nextAt))}</span>` : '',
    `<span class="wf-access ${esc(wf.access)}" title="${esc(WF_ACCESS[wf.access].text)}">${esc(WF_ACCESS[wf.access].short)}</span>`,
    v.folder ? `<span title="${esc(v.folder)}">in ${esc(shortPath(v.folder))}</span>` : '<span class="wf-warn">no folder yet</span>',
  ].filter(Boolean);
  const c = `data-card="${esc(card.id)}"`;
  const failed = last && ['failed', 'timeout', 'interrupted'].includes(last.status);
  const result = last && last.status === 'succeeded' && last.result.trim();
  return `
    <div class="wf${v.running ? ' is-running' : ''}${failed ? ' is-failed' : ''}">
      <div class="wf-row">
        <button class="wf-fold" data-act="wf-fold" data-wf="${esc(wf.id)}" aria-expanded="${open}" title="${open ? 'Hide' : 'Show'} its runs">${open ? '▾' : '▸'}</button>
        <div class="wf-main" data-act="wf-fold" data-wf="${esc(wf.id)}">
          <div class="wf-name">${esc(wf.name)}${onPage ? ` <a class="chip wf-card" href="#card=${esc(card.key)}" data-act="open-card" data-card="${esc(card.id)}" title="${esc(card.title)}">${esc(card.key)} ${esc(card.title.slice(0, 34))}</a>` : ''}</div>
          <div class="wf-meta">${meta.join('')}</div>
        </div>
        <div class="wf-btns">
          ${v.running
            ? `<button class="btn small" data-act="wf-log" data-run="${esc(last.id)}">Watch</button><button class="btn small danger" data-act="wf-stop" data-run="${esc(last.id)}">Stop</button>`
            : `<button class="btn small primary" data-act="wf-run" data-wf="${esc(wf.id)}" ${c} title="Run it now, in the background">▶ Run now</button>`}
          <button class="btn small ghost" data-act="wf-edit" data-wf="${esc(wf.id)}" ${c}>Edit</button>
        </div>
      </div>
      ${last ? `<div class="wf-last">${runChip(last)}${runLine(last)}${last.status !== 'running' ? `<span class="grow"></span><button class="btn small ghost" data-act="wf-log" data-run="${esc(last.id)}">Log</button>` : ''}</div>` : '<div class="wf-last muted">Not run yet.</div>'}
      ${failed ? `<div class="wf-error">${last.hint ? `<strong>${esc(last.hint)}</strong>` : esc(last.error || 'It did not finish.')}</div>` : ''}
      ${open && result ? `<div class="wf-result prose">${md(last.result)}</div>` : ''}
      ${open ? runsTable(runs) : ''}
    </div>`;
}

function runsTable(runs) {
  if (!runs.length) return '<div class="wf-runs muted">Each run is listed here, with its log and the session it ran in.</div>';
  return `<div class="wf-runs"><div class="wf-runs-head">Runs <span class="muted">(the last ${runs.length})</span></div>${runs
    .map(
      (r) => `<div class="wf-run">${runChip(r)}<span title="${esc(fullDate(r.startedAt))}">${esc(fullDate(r.startedAt))}</span><span class="muted">${esc(TRIGGER_LABEL[r.trigger] || '')}${r.endedAt ? ` · ${esc(duration(r.endedAt - r.startedAt))}` : ''}</span><span class="grow"></span>
        <button class="btn small ghost" data-act="wf-log" data-run="${esc(r.id)}">Log</button>
        ${r.status !== 'running' ? `<button class="btn small ghost" data-act="wf-resume" data-run="${esc(r.id)}" title="Copy the command that opens this run's session in a terminal, to ask it follow-up questions">Continue in terminal</button>` : ''}</div>`
    )
    .join('')}</div>`;
}

// ---------- the Workflows page: every card's workflows in one place ----------

const isFailed = (r) => r && ['failed', 'timeout', 'interrupted'].includes(r.status);

/** Every workflow on an open card in the current project, with its card and view. */
function allWorkflows() {
  const out = [];
  for (const card of S.data.cards) {
    if (card.archived || !(card.workflows || []).length || !cardMatches(card)) continue;
    const views = new Map((card.view.workflows || []).map((v) => [v.id, v]));
    for (const wf of card.workflows) out.push({ card, wf, v: views.get(wf.id) || {} });
  }
  return out;
}

/** The header pill: how many run now, or how many failed last time (in red). */
function workflowsPill() {
  const el = $('#n-wf');
  if (!el) return;
  const all = allWorkflows();
  const running = all.filter((x) => x.v.running).length;
  const failed = all.filter((x) => !x.v.running && isFailed(x.v.last)).length;
  el.textContent = running || failed || '';
  el.className = `pill${failed && !running ? ' needs' : ''}`;
  el.title = running ? `${running} running now` : failed ? `${failed} failed last time` : '';
  el.hidden = !(running || failed);
}

function renderWorkflows() {
  const all = allWorkflows();
  const row = (x) => workflowRow(x.card, x.wf, x.v, true);
  const running = all.filter((x) => x.v.running);
  const failed = all.filter((x) => !x.v.running && isFailed(x.v.last));
  const rest = all.filter((x) => !x.v.running && !isFailed(x.v.last));
  const scheduled = rest.filter((x) => x.v.nextAt && x.wf.enabled).sort((a, b) => a.v.nextAt - b.v.nextAt);
  const manual = rest.filter((x) => !scheduled.includes(x)).sort((a, b) => ((b.v.last || {}).startedAt || 0) - ((a.v.last || {}).startedAt || 0));
  const section = (title, list, help) => (list.length ? `<h2>${title} <span class="pill">${list.length}</span>${help ? `<span class="muted wf-h-help">${help}</span>` : ''}</h2>${list.map(row).join('')}` : '');
  const head = `<div class="wf-page-head"><div><strong>Workflows</strong> are prompts the board runs for you with Claude Code, by hand or on a schedule, on the Claude login of this Mac (no API key). Each lives on a card; its reports land in that card's notes.</div><button class="btn primary" data-act="wf-new" data-pick="1">New workflow</button></div>`;
  if (!all.length) {
    return `<div class="page" data-scroll="workflows"><div class="page-inner">${head}
      <div class="empty-state">${S.project ? `No workflows on ${esc(S.project)} cards yet.` : 'No workflows yet.'}<br>Make one here and pick its card, or open a card and press <em>Create a workflow</em>.</div></div></div>`;
  }
  return `<div class="page wf-page" data-scroll="workflows"><div class="page-inner">${head}
    ${section('Running now', running)}
    ${section('Failed last time', failed, 'Open the log to see why, then run it again.')}
    ${section('Coming up', scheduled, 'In the order they run next.')}
    ${section('By hand', manual, 'They run only when you press Run.')}
  </div></div>`;
}

function workflowsSection(card) {
  const list = card.workflows || [];
  const views = new Map((card.view.workflows || []).map((v) => [v.id, v]));
  const folder = card.view.folder;
  const body = list.length
    ? list.map((wf) => workflowRow(card, wf, views.get(wf.id) || {})).join('')
    : `<div class="wf-empty">
        <div><strong>Let Claude do this card's routine work on its own.</strong> A workflow is a prompt the board runs for you with Claude Code${folder ? ` in <code>${esc(shortPath(folder))}</code>` : ''}, whenever you press Run or on a schedule. Its progress shows here and its report lands in the notes.</div>
        <div class="help">It runs on the Claude login of this Mac: no API key, nothing to set up.</div>
        <div><button class="btn small primary" data-act="wf-new">Create a workflow</button></div>
      </div>`;
  return `
    <div class="sec">
      <div class="sec-head"><h4>Workflows</h4><span class="muted">${list.length || ''}</span><span class="grow"></span>${list.length ? '<button class="btn small" data-act="wf-new">New workflow</button>' : ''}</div>
      ${body}
    </div>`;
}

// ---------- the editor ----------

let wfAuth = null;
function loadAuth() {
  return fetch('/api/workflow/check')
    .then((r) => r.json())
    .then((j) => (wfAuth = j))
    .catch(() => (wfAuth = null));
}

function authLine() {
  const a = wfAuth;
  if (!a) return '<div class="wf-auth">Checking the Claude login on this Mac…</div>';
  if (!a.claude) return '<div class="wf-auth bad">The <code>claude</code> command is not installed, so workflows cannot run. Install Claude Code first.</div>';
  if (!a.loggedIn) return '<div class="wf-auth bad">Claude is not logged in on this Mac. Run <code>claude</code> in a terminal and type <code>/login</code>, then come back.</div>';
  const plan = a.plan ? ` (${esc(a.plan.charAt(0).toUpperCase() + a.plan.slice(1))} plan)` : '';
  const until = a.expiresAt ? new Date(a.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
  const soon = a.expiresAt && a.expiresAt - Date.now() < 7 * 86400e3;
  return `<div class="wf-auth${soon ? ' warn' : ''}">✓ Runs on your Claude login${plan}, no API key.${until ? ` The login lasts until ${esc(until)}${soon ? '. Log in again before then (<code>claude</code>, then <code>/login</code>) or scheduled runs will fail.' : '; using it does not extend it.'}` : ''}</div>`;
}

function editorHtml() {
  const st = M.state;
  const w = st.wf;
  const s = w.schedule || { kind: 'manual' };
  const opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
  const cards = st.pick ? S.data.cards.filter((c) => !c.archived && (c.id === st.cardId || cardMatches(c))).sort((a, b) => b.updatedAt - a.updatedAt) : [];
  return `<div class="dialog wide wf-dialog"><div class="dlg-head">${w.id ? 'Edit workflow' : st.pick ? 'New workflow' : `New workflow on ${esc(st.cardKey)}`}<span class="grow"></span><button class="icon-btn" data-act="modal-close">✕</button></div>
    <div class="dlg-body">
      ${st.pick ? `<label class="form-row"><span>Card</span><select class="field" id="wf-card" data-change="wf-card">${st.cardId ? '' : '<option value="">Pick the card it belongs to…</option>'}${cards.map((c) => opt(c.id, `${c.key} · ${c.title.slice(0, 70)}`, st.cardId)).join('')}</select>
        <div class="help">Its runs and reports show on this card, and it works in the card’s folder unless you name another.</div></label>` : ''}
      <label class="form-row"><span>Name</span><input class="field" id="wf-name" value="${esc(w.name || '')}" placeholder="Morning summary" maxlength="80"${w.id ? '' : ' data-autofocus'}></label>
      <div class="form-row"><span>What should Claude do?</span>
        <textarea class="field" id="wf-prompt" rows="7" placeholder="Write it as you would to a Claude session. It works alone, so say what to look at and what to report.">${esc(w.prompt || '')}</textarea>
        ${w.id ? '' : `<div class="wf-starters"><span class="muted">Start from</span>${STARTERS.map((x, i) => `<button class="chip" data-act="wf-starter" data-i="${i}">${esc(x.name)}</button>`).join('')}</div>`}
        <div class="help">It cannot ask you anything while it runs: what would need your approval is skipped, and it says so in its report.</div>
      </div>
      <label class="form-row"><span>Folder</span><input class="field" id="wf-folder" value="${esc(shortPath(w.folder || ''))}" placeholder="${esc(st.folder ? shortPath(st.folder) + ' (where this card’s sessions work)' : '~/work/your-project')}">
        <div class="help">${st.folder ? 'Leave it empty to use the folder this card’s sessions work in.' : st.cardId ? 'No folder is known for this card yet, so name the one it works in.' : 'Pick a card first: if its sessions work in a folder, that one is used.'}</div></label>
      <div class="form-row"><span>What it may do</span>
        <div class="wf-access-pick">${Object.entries(WF_ACCESS)
          .map(([k, a]) => `<label class="wf-choice${k === 'full' ? ' risky' : ''}${w.access === k ? ' on' : ''}"><input type="radio" name="wf-access" value="${k}" data-change="wf-access"${w.access === k ? ' checked' : ''}><strong>${esc(a.label)}</strong><span>${esc(a.text)}</span></label>`)
          .join('')}</div>
        <label class="check wf-trust"${w.access === 'full' ? '' : ' hidden'}><input type="checkbox" id="wf-trust"${st.trusted ? ' checked' : ''}> I trust this prompt and this folder: Claude may run any command and change any file here, with nobody watching</label>
      </div>
      <div class="form-row"><span>When</span>
        <div class="wf-when-pick">
          <select class="field" id="wf-kind" data-change="wf-kind">${opt('manual', 'Only when I press Run', s.kind)}${opt('hourly', 'Every few hours', s.kind)}${opt('daily', 'Every day', s.kind)}${opt('weekdays', 'Every weekday', s.kind)}${opt('weekly', 'Once a week', s.kind)}</select>
          <span class="wf-k" data-k="hourly"${s.kind === 'hourly' ? '' : ' hidden'}>every <select class="field" id="wf-every">${[1, 2, 3, 4, 6, 8, 12, 24].map((n) => opt(n, `${n} hour${n === 1 ? '' : 's'}`, s.every || 1)).join('')}</select></span>
          <span class="wf-k" data-k="weekly"${s.kind === 'weekly' ? '' : ' hidden'}>on <select class="field" id="wf-day">${WEEKDAYS.map((d, i) => opt(i, d, s.day == null ? 1 : s.day)).join('')}</select></span>
          <span class="wf-k" data-k="daily weekdays weekly"${['daily', 'weekdays', 'weekly'].includes(s.kind) ? '' : ' hidden'}>at <input class="field" type="time" id="wf-at" value="${esc(s.at || '09:00')}"></span>
        </div>
        <div class="help">Scheduled runs happen while this Mac is awake and the board is running. A time missed while it slept runs once when it wakes.</div>
      </div>
      <div class="wf-two">
        <label class="form-row"><span>Time limit</span><select class="field" id="wf-timeout">${[5, 10, 15, 30, 60, 120, 240].map((n) => opt(n, n < 60 ? `${n} minutes` : `${n / 60} hour${n === 60 ? '' : 's'}`, w.timeoutMin || 30)).join('')}</select></label>
        <label class="form-row"><span>Model</span><select class="field" id="wf-model">${opt('', 'Your default', w.model)}${opt('opus', 'Opus', w.model)}${opt('sonnet', 'Sonnet', w.model)}${opt('haiku', 'Haiku (fastest)', w.model)}</select></label>
      </div>
      <label class="check"><input type="checkbox" id="wf-note"${w.postNote === false ? '' : ' checked'}> Add each run’s report to the card’s notes, where the card’s next sessions read it</label>
      ${authLine()}
    </div>
    <div class="dlg-foot">
      ${w.id ? '<button class="btn ghost danger" data-act="wf-delete">Delete</button>' : ''}
      ${w.id && w.schedule && w.schedule.kind !== 'manual' ? `<button class="btn ghost" data-act="wf-pause">${w.enabled ? 'Pause schedule' : 'Resume schedule'}</button>` : ''}
      <span class="grow"></span>
      <button class="btn" data-act="modal-close">Cancel</button>
      <button class="btn" data-act="wf-save">Save</button>
      <button class="btn primary" data-act="wf-save" data-run="1">Save and run now</button>
    </div></div>`;
}

function openEditor(wfId, cardId, pick) {
  const card = (cardId && ix().cards.get(cardId)) || currentCard();
  if (!card && !pick) return;
  const existing = wfId && (card.workflows || []).find((w) => w.id === wfId);
  const wf = existing ? JSON.parse(JSON.stringify(existing)) : { name: '', prompt: '', folder: '', access: 'read', schedule: { kind: 'manual' }, timeoutMin: 30, model: '', postNote: true, enabled: true };
  showModal('wf-edit', '', { cardId: card ? card.id : '', cardKey: card ? card.key : '', folder: card ? card.view.folder : '', wf, trusted: wf.access === 'full', pick: !!pick });
  paintEditor();
  // asked each time: the login can have changed since
  loadAuth().then(() => {
    const line = M.kind === 'wf-edit' && $('.wf-auth');
    if (line) line.outerHTML = authLine();
  });
}

function paintEditor() {
  $('#modal').innerHTML = editorHtml();
  const first = $('[data-autofocus]', $('#modal'));
  if (first) first.focus();
}

/** What the form says now, as a workflow. */
function readEditor() {
  const w = M.state.wf;
  const kind = $('#wf-kind').value;
  const schedule = { kind };
  if (kind === 'hourly') schedule.every = +$('#wf-every').value;
  if (['daily', 'weekdays', 'weekly'].includes(kind)) schedule.at = $('#wf-at').value;
  if (kind === 'weekly') schedule.day = +$('#wf-day').value;
  const checked = $('input[name="wf-access"]:checked');
  return {
    id: w.id,
    name: $('#wf-name').value.trim(),
    prompt: $('#wf-prompt').value.trim(),
    folder: $('#wf-folder').value.trim(),
    access: checked ? checked.value : 'read',
    schedule,
    timeoutMin: +$('#wf-timeout').value,
    model: $('#wf-model').value,
    postNote: $('#wf-note').checked,
  };
}

CHANGES['wf-kind'] = (el) => {
  for (const k of $$('.wf-k')) k.hidden = !k.dataset.k.split(' ').includes(el.value);
};
CHANGES['wf-access'] = (el) => {
  for (const c of $$('.wf-choice')) c.classList.toggle('on', $('input', c).checked);
  $('.wf-trust').hidden = el.value !== 'full';
};
ACTIONS['wf-starter'] = (el) => {
  const x = STARTERS[+el.dataset.i];
  const name = $('#wf-name');
  const prompt = $('#wf-prompt');
  if (!name.value.trim()) name.value = x.name;
  prompt.value = x.prompt;
  prompt.focus();
  const hole = x.prompt.indexOf('<name>');
  if (hole >= 0) prompt.setSelectionRange(hole, hole + 6);
};
CHANGES['wf-card'] = (el) => {
  const card = ix().cards.get(el.value);
  const st = M.state;
  st.wf = { ...st.wf, ...readEditor(), id: st.wf.id };
  st.trusted = $('#wf-trust').checked;
  Object.assign(st, { cardId: card ? card.id : '', cardKey: card ? card.key : '', folder: card ? card.view.folder : '' });
  paintEditor();
};
ACTIONS['wf-new'] = (el) => openEditor(null, null, !!el.dataset.pick);
ACTIONS['wf-edit'] = (el) => openEditor(el.dataset.wf, el.dataset.card);
ACTIONS['wf-fold'] = (el) => {
  const id = el.dataset.wf;
  S.wfOpen.has(id) ? S.wfOpen.delete(id) : S.wfOpen.add(id);
  render();
};

ACTIONS['wf-save'] = async (el) => {
  const wf = readEditor();
  const { cardId } = M.state;
  if (!cardId) {
    $('#wf-card').focus();
    return toast('Pick the card this workflow belongs to.', 'error');
  }
  if (!wf.prompt) {
    $('#wf-prompt').focus();
    return toast('Say what Claude should do.', 'error');
  }
  // "Anything" is the one choice that can do harm unattended: it has to be said in so many words
  if (wf.access === 'full' && !$('#wf-trust').checked) {
    $('.wf-trust').classList.add('ask');
    return toast('Tick the box under “Anything” to confirm, or pick a safer choice.', 'error');
  }
  const saved = await op('workflow.save', { card: cardId, workflow: wf });
  if (!saved) return; // the reason is already in a toast; the form stays as it was typed
  closeModal(null);
  S.wfOpen.add(saved.id);
  if (el.dataset.run) runWorkflow(cardId, saved.id);
  else toast(saved.schedule.kind === 'manual' ? 'Workflow saved. Press Run now to start it.' : `Workflow saved. “${saved.name}” runs ${scheduleText(saved.schedule)}.`);
};
const scheduleText = (s) => (s.kind === 'hourly' ? `every ${s.every === 1 ? 'hour' : s.every + ' hours'}` : s.kind === 'daily' ? `every day at ${s.at}` : s.kind === 'weekdays' ? `on weekdays at ${s.at}` : `every ${WEEKDAYS[s.day]} at ${s.at}`);

// two clicks, so a stray one never loses a workflow
ACTIONS['wf-delete'] = async (el) => {
  const { cardId, wf } = M.state;
  if (!el.classList.contains('armed')) {
    el.classList.add('armed');
    el.textContent = 'Click again to delete';
    return setTimeout(() => {
      if (el.isConnected) {
        el.classList.toggle('armed', false);
        el.textContent = 'Delete';
      }
    }, 4000);
  }
  if (await op('workflow.remove', { card: cardId, workflow: wf.id })) {
    closeModal(null);
    toast('Workflow deleted. Notes it added to the card stay.');
  }
};
ACTIONS['wf-pause'] = async () => {
  const { cardId, wf } = M.state;
  const done = await op('workflow.enable', { card: cardId, workflow: wf.id, enabled: !wf.enabled });
  if (done) {
    closeModal(null);
    toast(done.enabled ? 'Schedule resumed. It runs next at its next time.' : 'Schedule paused. You can still run it by hand.');
  }
};

// ---------- running ----------

async function runWorkflow(cardId, wfId) {
  const j = await post('/api/workflow/run', { card: cardId, workflow: wfId }).catch(() => null);
  if (!j) return toast('The board server is not responding. Run "taskboard start".', 'error');
  if (!j.ok) return toast(j.error || 'It did not start.', 'error');
  setData(j.state);
  toast('Started. It runs in the background; you can close the board.');
}
ACTIONS['wf-run'] = (el) => runWorkflow(el.dataset.card || S.cardId, el.dataset.wf);
ACTIONS['wf-stop'] = async (el) => {
  const j = await post('/api/workflow/stop', { run: el.dataset.run }).catch(() => null);
  if (!j || !j.ok) return toast((j && j.error) || 'Could not stop it.', 'error');
  toast('Stopping…');
};

function findRun(runId) {
  for (const c of S.data.cards) {
    const r = (c.runs || []).find((x) => x.id === runId);
    if (r) return { card: c, run: r, wf: (c.workflows || []).find((w) => w.id === r.workflowId) };
  }
  return null;
}

ACTIONS['wf-resume'] = async (el) => {
  const hit = findRun(el.dataset.run);
  if (!hit) return;
  await copyText(`cd ${JSON.stringify(hit.run.cwd)} && claude --resume ${hit.run.sessionId}`);
  toast('Command copied. Paste it in a terminal to pick up where that run stopped.');
};

// ---------- the log ----------

const LOG_ICON = { status: '•', tool: '›', text: '', result: '✓', error: '✕', denied: '⊘' };
let logTimer = null;

function logHtml(runId, events) {
  const hit = findRun(runId);
  const r = (M.state.run && M.state.run.id === runId ? M.state.run : null) || (hit && hit.run);
  const name = hit && hit.wf ? hit.wf.name : 'Workflow run';
  const rows = (events || [])
    .map((e) => `<div class="log-ev ${esc(e.kind)}"><span class="log-ic">${LOG_ICON[e.kind] || ''}</span><div>${e.kind === 'text' || e.kind === 'result' ? `<div class="prose">${md(e.text)}</div>` : esc(e.text)}</div></div>`)
    .join('');
  return `<div class="dialog wide"><div class="dlg-head">${esc(name)}${r ? runChip(r) : ''}<span class="grow"></span><button class="icon-btn" data-act="modal-close">✕</button></div>
    <div class="dlg-body wf-log" data-scroll="wf-log">
      ${r ? `<div class="help">Started ${esc(fullDate(r.startedAt))} ${esc(TRIGGER_LABEL[r.trigger] || '')} in <code>${esc(shortPath(r.cwd))}</code>${r.endedAt ? `, took ${esc(duration(r.endedAt - r.startedAt))}` : ''}.${r.denied ? ` ${r.denied} action${r.denied === 1 ? ' was' : 's were'} not allowed by what it may do (⊘ below); edit the workflow to give it more room if it needs them.` : ''}</div>` : ''}
      ${r && r.hint ? `<div class="wf-error"><strong>${esc(r.hint)}</strong></div>` : r && r.error && r.status !== 'succeeded' ? `<div class="wf-error">${esc(r.error)}</div>` : ''}
      ${rows || `<div class="muted">${r && r.status === 'running' ? 'Waiting for Claude to start…' : 'Nothing was recorded for this run.'}</div>`}
      ${r && r.status === 'running' ? '<div class="log-ev status"><span class="log-ic"><i class="spin"></i></span><div class="muted">Working…</div></div>' : ''}
    </div>
    <div class="dlg-foot">${r && r.status !== 'running' ? '<button class="btn ghost" data-act="wf-resume" data-run="' + esc(runId) + '" title="Copy the command that opens this run in a terminal">Continue in terminal</button>' : ''}<span class="grow"></span>
      ${r && r.status === 'running' ? `<button class="btn danger" data-act="wf-stop" data-run="${esc(runId)}">Stop</button>` : ''}<button class="btn" data-act="modal-close">Close</button></div></div>`;
}

async function refreshLog(runId, first) {
  if (M.kind !== 'wf-log' || M.state.runId !== runId) return;
  const j = await fetch('/api/workflow/log?run=' + encodeURIComponent(runId)).then((x) => x.json()).catch(() => null);
  if (M.kind !== 'wf-log' || M.state.runId !== runId) return;
  if (!j || !j.ok) {
    $('#modal').innerHTML = logHtml(runId, []);
    return;
  }
  M.state.run = j.run;
  const body = $('.wf-log');
  // follow the end while it is being written, unless the user scrolled up to read
  const atEnd = !body || first || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  swap($('#modal'), logHtml(runId, j.events));
  const now = $('.wf-log');
  if (now && atEnd) now.scrollTop = now.scrollHeight;
  clearTimeout(logTimer);
  if (j.run.status === 'running') logTimer = setTimeout(() => refreshLog(runId), 1500);
}

ACTIONS['wf-log'] = (el) => {
  const runId = el.dataset.run;
  showModal('wf-log', logHtml(runId, null), { runId });
  refreshLog(runId, true);
};
