'use strict';
// Focus mode: one decision at a time, across projects. The server says which sessions belong
// here (state.focus); this file decides which one is on screen, and keeps it there until the
// user moves on, so a prompt arriving elsewhere never swaps the card under their hands.

const FOCUS_STORE = 'tb-focus-projects';
const FOCUS_ARM_MS = 600; // a key meant for the previous card must not act on this one
const FOCUS_KIND = { question: 'Question', permission: 'Tool approval', plan: 'Plan', input: 'Input', reply: 'Reply' };
const FOCUS_HEAD = {
  question: 'Claude has a question',
  permission: 'Claude is waiting to use this tool',
  plan: 'Claude has a plan for you to review',
  input: 'Claude is waiting for you',
  reply: 'Claude finished and asked you something',
};

function focusSavedProjects() {
  try {
    const v = JSON.parse(localStorage.getItem(FOCUS_STORE) || '[]');
    return new Set(Array.isArray(v) ? v.filter((p) => typeof p === 'string') : []);
  } catch (_) {
    return new Set();
  }
}

S.focus = { key: null, shown: null, gone: false, armedAt: 0, dropped: null, projects: focusSavedProjects() };

function focusLists() {
  const f = S.data.focus || { decide: [], reply: [], active: [] };
  const x = ix();
  const chosen = S.focus.projects;
  const inScope = (s) => !chosen.size || [...chosen].some((p) => inProject(s, p));
  const pick = (ids, tier) =>
    ids
      .map((id) => x.sessions.get(id))
      .filter((s) => s && inScope(s))
      .map((s) => ({ s, tier, key: `${s.id}:${s.token}` }))
      .filter((item) => item.key !== S.focus.dropped);
  const everyone = [...f.decide, ...f.reply, ...f.active].map((id) => x.sessions.get(id)).filter(Boolean);
  return { queue: [...pick(f.decide, 'decide'), ...pick(f.reply, 'reply')], active: pick(f.active, 'active'), everyone };
}

function focusSet(item) {
  const f = S.focus;
  f.key = item ? item.key : null;
  f.shown = item || null;
  f.gone = false;
  f.armedAt = item ? Date.now() + FOCUS_ARM_MS : 0;
}

/** The card on screen: the same one as before, unless the user moved on. */
function focusCurrent(queue) {
  const f = S.focus;
  const same = f.key && queue.find((item) => item.key === f.key);
  if (same) {
    f.shown = same;
    f.gone = false;
    return same;
  }
  if (f.key && f.shown) {
    f.gone = true; // answered in Claude, or closed: say so and wait for the user
    return f.shown;
  }
  focusSet(queue[0] || null);
  return f.shown;
}

function focusShow(item) {
  focusSet(item);
  renderMain();
}

function focusStep(by) {
  const { queue } = focusLists();
  if (!queue.length) return focusShow(null);
  const at = queue.findIndex((item) => item.key === S.focus.key);
  focusShow(at < 0 ? queue[0] : queue[(at + by + queue.length) % queue.length]);
}

async function focusHandled() {
  const f = S.focus;
  if (!f.shown || f.gone || Date.now() < f.armedAt) return;
  const { s, key } = f.shown;
  const { queue } = focusLists();
  const at = queue.findIndex((item) => item.key === key);
  const rest = queue.filter((item) => item.key !== key);
  f.dropped = key;
  focusShow(rest[Math.max(at, 0)] || rest[rest.length - 1] || null);
  const done = await op('session.meta', { sessionIds: [s.id], ack: { [s.id]: s.token } });
  f.dropped = null;
  if (done) toast('Marked as handled. It comes back if the session asks again.');
  else renderMain();
}

/** Left the Focus view: a card that was already answered has nothing to come back to. */
function focusLeave() {
  document.body.classList.remove('focus-on');
  if (S.focus.gone) focusSet(null);
}

function focusPill() {
  const el = $('#n-focus');
  if (!el) return;
  const n = focusLists().queue.length;
  el.textContent = n || '';
  el.hidden = !n;
}

// ---------- rendering ----------

function focusQuestion(q) {
  return `
    <div class="fc-q">
      ${q.header ? `<div class="fc-q-head">${esc(q.header)}${q.multi ? ' · choose any' : ''}</div>` : ''}
      <div class="fc-ask">${esc(q.question)}</div>
      ${q.options.length ? `<ul class="fc-options">${q.options.map((o) => `<li><strong>${esc(o.label)}</strong>${o.description ? `<span>${esc(o.description)}</span>` : ''}</li>`).join('')}</ul>` : ''}
    </div>`;
}

function focusCall(c) {
  return `
    <div class="fc-call">
      <div class="fc-call-head">${esc(c.label)}</div>
      ${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}
      ${c.text ? `<pre class="fc-code" tabindex="0">${esc(c.text)}</pre>` : ''}
    </div>`;
}

function focusBody(s, w) {
  if (!w) {
    const ask = (s.summary && s.summary.needsAction) || 'Waiting for your reply.';
    const detail = (s.summary && s.summary.detail) || s.wrapUp || '';
    return `<div class="fc-ask">${esc(ask)}</div>${detail && detail !== ask ? `<p class="fc-detail">${esc(detail)}</p>` : ''}`;
  }
  if (w.kind === 'question') return w.questions.map(focusQuestion).join('');
  if (w.kind === 'plan') {
    return w.plan ? `<pre class="fc-code fc-plan" tabindex="0">${esc(w.plan)}</pre>` : `<div class="fc-ask">${esc(w.ask)}</div>`;
  }
  if (w.kind === 'permission') {
    return `${w.calls.length > 1 ? '<p class="fc-detail">It is stopped on one of these calls.</p>' : ''}${w.calls.map(focusCall).join('')}`;
  }
  return `<div class="fc-ask">${esc(w.ask)}</div>`;
}

function focusCard(item, queue) {
  const { s, tier } = item;
  const gone = S.focus.gone;
  const w = tier === 'decide' ? s.waiting : null;
  const kind = w ? w.kind : 'reply';
  const card = s.cardId && ix().cards.get(s.cardId);
  const since = ago((w && w.since) || s.lastActivityAt);
  const at = queue.findIndex((q) => q.key === item.key);
  const step = s.steps && s.steps.current;
  return `
    <article class="fc-card${gone ? ' gone' : ''}" aria-label="${esc(FOCUS_KIND[kind])} from ${esc(s.title)}">
      <div class="fc-meta">
        <span class="fc-kind ${esc(kind)}">${esc(FOCUS_KIND[kind])}</span>
        ${projChip(s.projectName)}
        ${card ? `<a class="chip" href="#card=${esc(card.key)}" data-act="open-card" data-card="${esc(card.id)}">${esc(card.key)}</a>` : ''}
        <span class="grow"></span>
        ${gone ? '' : `<span class="muted">waiting ${since === 'now' ? 'just now' : esc(since)}</span>`}
        ${!gone && queue.length > 1 ? `<span class="muted">${at + 1} of ${queue.length}</span>` : ''}
      </div>
      <h2 class="fc-title" data-act="session-info" data-session="${esc(s.id)}">${esc(s.title)}</h2>
      ${step ? `<div class="fc-step">On “${esc(step)}”</div>` : ''}
      ${gone ? '<div class="fc-gone">No longer waiting. It was answered in Claude, or the session closed.</div>' : `<h3 class="fc-head">${esc(FOCUS_HEAD[kind])}</h3><div class="fc-body" data-scroll="focus-body">${focusBody(s, w)}</div>`}
      <div class="fc-actions">
        ${gone
          ? `<button class="btn primary" data-act="focus-step" data-step="1">${queue.length ? 'Next decision' : 'Done'} <kbd>J</kbd></button>`
          : `${openButton(s, 'primary')}<button class="btn" data-act="focus-handled" title="Hide it until this session asks something new">Mark handled <kbd>H</kbd></button>`}
        <span class="grow"></span>
        ${!gone && queue.length > 1 ? '<button class="btn ghost" data-act="focus-step" data-step="-1" title="Previous decision">‹ <kbd>K</kbd></button><button class="btn ghost" data-act="focus-step" data-step="1" title="Next decision"><kbd>J</kbd> ›</button>' : ''}
      </div>
    </article>`;
}

function focusRow(item, current) {
  const { s, tier } = item;
  const kind = tier === 'decide' ? s.waiting.kind : 'reply';
  return `
    <button class="fc-row${item.key === current ? ' on' : ''}" data-act="focus-pick" data-key="${esc(item.key)}">
      ${stateDot('needs_you')}
      <span class="fc-row-body"><span class="fc-row-title">${esc(s.title)}</span><span class="fc-row-sub">${esc(FOCUS_KIND[kind])} · ${esc(s.projectName || 'No project')}</span></span>
    </button>`;
}

function focusActiveRow({ s }) {
  const line = s.estate === 'running' ? (s.steps && s.steps.current) || 'Running' : `${STATE_LABEL[s.estate] || s.estate} · ${ago(s.lastActivityAt)}`;
  return `
    <button class="fc-row" data-act="session-info" data-session="${esc(s.id)}">
      ${stateDot(s.estate)}
      <span class="fc-row-body"><span class="fc-row-title">${esc(s.title)}</span><span class="fc-row-sub">${esc(line)}</span></span>
    </button>`;
}

function focusProjects(everyone) {
  const chosen = S.focus.projects;
  const names = [...new Set([...everyone.map((s) => s.projectName).filter(Boolean), ...chosen])].sort((a, b) => a.localeCompare(b));
  if (names.length < 2 && !chosen.size) return '';
  return `<div class="fc-projects" role="group" aria-label="Projects">
    <button class="fc-project${chosen.size ? '' : ' on'}" data-act="focus-project" data-project="" aria-pressed="${!chosen.size}">All</button>
    ${names.map((p) => `<button class="fc-project${chosen.has(p) ? ' on' : ''}" data-act="focus-project" data-project="${esc(p)}" aria-pressed="${chosen.has(p)}">${esc(p)}</button>`).join('')}
  </div>`;
}

function renderFocus() {
  document.body.classList.add('focus-on');
  const { queue, active, everyone } = focusLists();
  const current = focusCurrent(queue);
  const decide = queue.filter((i) => i.tier === 'decide').length;
  const running = active.filter((i) => i.s.estate === 'running').length;
  const counts = [decide && `${decide} to decide`, queue.length - decide && `${queue.length - decide} to reply`, running && `${running} running`].filter(Boolean).join(' · ');
  const next = queue.filter((i) => i.key !== S.focus.key);
  const scoped = S.focus.projects.size ? ' in these projects' : '';
  return `<div class="focus-page" data-scroll="focus"><div class="fc-inner">
    <div class="fc-bar"><h1>Focus</h1><span class="muted">${esc(counts)}</span><span class="grow"></span>${focusProjects(everyone)}</div>
    <div class="fc-layout">
      <section class="fc-stage">
        ${current ? focusCard(current, queue) : `<div class="fc-empty"><strong>Nothing needs you${scoped}</strong><span>New prompts come up here on their own.</span></div>`}
        ${current && !S.focus.gone ? '<div class="fc-keys"><kbd>O</kbd> open in Claude <kbd>H</kbd> mark handled <kbd>J</kbd> <kbd>K</kbd> next, previous</div>' : ''}
      </section>
      <aside class="fc-rail">
        <h4>Up next</h4>
        ${next.length ? next.map((i) => focusRow(i, S.focus.key)).join('') : '<div class="fc-none">Nothing else waiting</div>'}
        <h4>Active</h4>
        ${active.length ? active.map(focusActiveRow).join('') : '<div class="fc-none">Nothing active</div>'}
      </aside>
    </div>
  </div></div>`;
}

// ---------- actions ----------

ACTIONS['focus-pick'] = (el) => {
  const item = focusLists().queue.find((i) => i.key === el.dataset.key);
  if (item) focusShow(item);
};
ACTIONS['focus-step'] = (el) => focusStep(+el.dataset.step || 1);
ACTIONS['focus-handled'] = () => focusHandled();
ACTIONS['focus-project'] = (el) => {
  const chosen = S.focus.projects;
  const p = el.dataset.project;
  if (!p) chosen.clear();
  else if (chosen.has(p)) chosen.delete(p);
  else chosen.add(p);
  try {
    localStorage.setItem(FOCUS_STORE, JSON.stringify([...chosen]));
  } catch (_) {}
  focusSet(null);
  render();
};

/** Focus mode's keys. True when the key was used. */
function focusKey(e) {
  if (e.key === 'f' && S.view !== 'focus' && !S.cardId) {
    S.view = 'focus';
    setHash();
    render();
    return true;
  }
  if (S.view !== 'focus' || S.cardId) return false;
  if (e.key === 'j' || e.key === 'ArrowRight') focusStep(1);
  else if (e.key === 'k' || e.key === 'ArrowLeft') focusStep(-1);
  else if (e.key === 'h') focusHandled();
  else if (e.key === 'o') {
    const f = S.focus;
    if (f.shown && !f.gone && Date.now() >= f.armedAt) openSession(f.shown.s.id);
  } else return false;
  return true;
}
