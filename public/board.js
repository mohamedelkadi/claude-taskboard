'use strict';
// The kanban view: columns of cards, plus the rail of sessions that are not on
// a card yet. Cards drag between columns; sessions drag onto cards or columns.

const COL_COLORS = { backlog: 'var(--idle)', todo: 'var(--muted)', in_progress: 'var(--running)', waiting: 'var(--needs)', review: 'var(--review)', done: 'var(--done)' };

function cardFace(card) {
  const v = card.view;
  const c = v.counts;
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const links = card.links.length + S.data.cards.filter((o) => o.links.some((l) => l.to === card.id)).length;
  const detected = S.data.implicit.filter((p) => p.a === card.id || p.b === card.id).length;
  const sessions = v.subs.filter((s) => s.kind !== 'manual').length;
  const sig = [];
  if (c.running) sig.push(`<span class="sig running">● ${c.running} running</span>`);
  if (c.needs) sig.push(`<span class="sig needs">${c.needs} need${c.needs === 1 ? 's' : ''} you</span>`);
  if (c.review) sig.push(`<span class="sig review">${c.review} to review</span>`);
  const prs = v.prs.slice().sort((a, b) => (a.state === 'OPEN' ? -1 : 1) - (b.state === 'OPEN' ? -1 : 1)).slice(0, 3);
  return `
    <article class="card prio-${esc(card.priority)}${S.cardId === card.id ? ' open' : ''}" draggable="true" data-card="${esc(card.id)}" data-act="open-card">
      <div class="card-top">
        <span class="key">${esc(card.key)}</span>${ticketChip(card.ticket)}${projChip(card.project)}
        ${card.priority === 'high' || card.priority === 'urgent' ? `<span class="chip tag">${PRIO_LABEL[card.priority]}</span>` : ''}
        ${card.tags.map((t) => `<span class="chip tag">${esc(t)}</span>`).join('')}
      </div>
      <h3>${esc(card.title)}</h3>
      ${c.total ? `<div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><span>${c.done}/${c.total}</span></div>` : ''}
      ${sig.length ? `<div class="signals">${sig.join('')}</div>` : ''}
      <div class="card-foot">
        ${prs.map(prChip).join('')}${v.prs.length > 3 ? `<span class="muted">+${v.prs.length - 3}</span>` : ''}
        ${sessions ? `<span class="muted" title="Claude sessions on this card">${sessions} session${sessions === 1 ? '' : 's'}</span>` : ''}
        ${links ? `<span title="Connected to ${links} other card${links === 1 ? '' : 's'}">⤳ ${links}</span>` : ''}
        ${detected ? `<span class="muted" title="Its sessions share a PR or a parent with ${detected} other card${detected === 1 ? '' : 's'}. Open the card to connect them.">${links ? '+' : '⤳ '}${detected} possible</span>` : ''}
        <span class="grow"></span><span title="${esc(fullDate(v.lastActivityAt))}">${esc(ago(v.lastActivityAt))}</span>
      </div>
    </article>`;
}

function sessionRow(s) {
  const x = ix();
  const routine = s.routineId && x.routines.get(s.routineId);
  const sug = s.suggest && x.cards.get(s.suggest.cardId);
  return `
    <div class="sess" draggable="true" data-session="${esc(s.id)}">
      ${stateDot(s.estate)}
      <div class="sess-body">
        <div class="sess-title" data-act="session-info" data-session="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title)}</div>
        <div class="sess-meta">${projChip(s.projectName)}${routine ? `<span>⏰ ${routine.runs} runs</span>` : ''}<span>${esc(ago(s.lastActivityAt))}</span>${s.prs.slice(0, 2).map(prChip).join('')}</div>
        ${sug ? `<button class="suggest" data-act="accept-suggest" data-session="${esc(s.id)}" data-card="${esc(sug.id)}" title="Link to this card">→ ${esc(sug.key)} ${esc(sug.title.slice(0, 26))} · ${esc(s.suggest.reason)}</button>` : ''}
      </div>
      ${openButton(s, 'ghost narrow')}
      <button class="icon-btn" data-act="hide-session" data-session="${esc(s.id)}" title="Hide from this list">✕</button>
    </div>`;
}

/** A session that is already on a card, shown when a search finds it. Not draggable: it has a place. */
function cardSessionRow(s) {
  const x = ix();
  const card = x.cards.get(s.cardId);
  return `
    <div class="sess found" data-session="${esc(s.id)}">
      ${stateDot(s.estate)}
      <div class="sess-body">
        <div class="sess-title" data-act="session-info" data-session="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title)}</div>
        <div class="sess-meta">${card ? `<a class="chip" href="#card=${esc(card.key)}" data-act="open-card" data-card="${esc(card.id)}">${esc(card.key)} ${esc(card.title.slice(0, 26))}</a>` : ''}${projChip(s.projectName)}<span>${esc(ago(s.lastActivityAt))}</span>${s.archived ? '<span>archived</span>' : ''}</div>
      </div>
      ${openButton(s, 'ghost narrow')}
    </div>`;
}

function renderBoard() {
  const x = ix();
  const d = S.data;
  const unsorted = x.unsorted.filter(sessionMatches);
  // a search also finds sessions that are already on a card, which the unsorted list leaves out
  const onCards = searching() ? x.visible.filter((s) => s.cardId && sessionMatches(s)).sort(byRecent) : [];
  const inbox = S.inbox
    ? `<aside class="inbox">
        <div class="inbox-head">Unsorted sessions <span class="pill">${unsorted.length}</span><span class="grow"></span><button class="icon-btn" data-act="toggle-inbox" title="Hide">⟨</button></div>
        <div class="inbox-hint">Drag one onto a card to file it there, or into a column to make a card from it.</div>
        <div class="inbox-list" data-scroll="inbox">
          ${unsorted.length ? unsorted.map(sessionRow).join('') : onCards.length ? '' : `<div class="inbox-empty">${searching() ? 'No session matches.' : x.unsorted.length ? 'Nothing matches the filter.' : 'Every open session is on a card.'}</div>`}
          ${onCards.length ? `<div class="inbox-sub">On a card <span class="pill">${onCards.length}</span></div>${onCards.slice(0, 30).map(cardSessionRow).join('')}${onCards.length > 30 ? `<div class="inbox-empty">${onCards.length - 30} more under Sessions.</div>` : ''}` : ''}
        </div>
      </aside>`
    : `<button class="inbox-toggle" data-act="toggle-inbox" title="Show unsorted sessions">Unsorted · ${x.unsorted.length}</button>`;

  const cols = d.columns
    .map((col) => {
      const cards = d.cards.filter((c) => c.status === col.id && !c.archived && cardMatches(c)).sort((a, b) => a.order - b.order);
      const composer =
        S.composer === col.id
          ? `<div class="composer">
              <textarea class="field" data-keep="composer" id="composer" placeholder="What is the task?"></textarea>
              <div class="composer-row"><button class="btn primary small" data-act="composer-add">Add card</button><button class="btn ghost small" data-act="composer-cancel">Cancel</button></div>
            </div>`
          : '';
      return `
        <section class="col" data-col="${esc(col.id)}">
          <div class="col-head">
            <span class="dot" style="background:${COL_COLORS[col.id] || 'var(--accent)'}"></span>
            <span class="col-name">${esc(col.name)}</span><span class="pill">${cards.length}</span><span class="grow"></span>
            <button class="icon-btn" data-act="new-card" data-col="${esc(col.id)}" title="New card here">＋</button>
          </div>
          <div class="col-body" data-col="${esc(col.id)}" data-scroll="col-${esc(col.id)}">
            ${composer}${cards.map(cardFace).join('')}
            ${!cards.length && !composer ? `<div class="col-empty">${S.q || S.project ? 'No matching cards' : 'Drop a card or a session here'}</div>` : ''}
          </div>
        </section>`;
    })
    .join('');
  return `<div class="board-wrap">${inbox}<div class="board" data-scroll="board">${cols}</div></div>`;
}

// ---------- actions ----------

ACTIONS['toggle-inbox'] = () => {
  S.inbox = !S.inbox;
  render();
};

ACTIONS['new-card'] = (el) => {
  S.view = 'board';
  S.composer = el.dataset.col || (ix().cols.has('todo') ? 'todo' : S.data.columns[0].id);
  setHash();
  render();
  const box = $('#composer');
  if (box) {
    box.focus();
    box.scrollIntoView({ block: 'nearest' });
  }
};

async function composerAdd() {
  const box = $('#composer');
  const title = box ? box.value.trim() : '';
  if (!title) return box && box.focus();
  const status = S.composer;
  box.value = '';
  const card = await op('card.create', { title, status, project: S.project || '' });
  if (card) {
    const again = $('#composer');
    if (again) again.focus(); // keep adding, Trello-style
  }
}
ACTIONS['composer-add'] = composerAdd;
ACTIONS['composer-cancel'] = () => {
  S.composer = null;
  render();
};

ACTIONS['hide-session'] = async (el) => {
  if (await op('session.meta', { sessionIds: [el.dataset.session], hidden: true })) toast('Hidden. Find it again under Sessions → All.');
};

ACTIONS['accept-suggest'] = (el) => op('session.link', { card: el.dataset.card, sessionIds: [el.dataset.session] });

/** Make a card out of a session (its title, project and ticket carry over). */
function cardFromSessions(ids, status) {
  const x = ix();
  const list = ids.map((id) => x.sessions.get(id)).filter(Boolean);
  if (!list.length) return null;
  const first = list.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
  const routine = first.routineId && x.routines.get(first.routineId);
  const ticket = (list.find((s) => s.tickets.length) || { tickets: [''] }).tickets[0];
  const args = { title: first.title, status, project: first.projectName, ticket, auto: ticket ? { ticketKeys: [ticket] } : undefined };
  if (routine) {
    // all runs of a scheduled task travel together
    return op('card.create', { ...args, tags: ['routine'] }).then((card) => card && op('routine.link', { card: card.id, routineId: routine.id }).then(() => card));
  }
  return op('card.create', { ...args, sessionIds: list.map((s) => s.id) });
}

function linkSessionsTo(cardId, ids) {
  const x = ix();
  const plain = [];
  let chain = Promise.resolve(true);
  for (const id of ids) {
    const s = x.sessions.get(id);
    if (s && s.routineId) chain = chain.then(() => op('routine.link', { card: cardId, routineId: s.routineId }));
    else plain.push(id);
  }
  return plain.length ? chain.then(() => op('session.link', { card: cardId, sessionIds: plain })) : chain;
}

// ---------- drag and drop ----------

function clearDropMarks() {
  for (const el of $$('.drop-line')) el.remove();
  for (const el of $$('.drop-target')) el.classList.remove('drop-target');
  for (const el of $$('.drop-col')) el.classList.remove('drop-col');
}

function initBoardDnD() {
  const main = $('#main');

  main.addEventListener('dragstart', (e) => {
    const card = e.target.closest && e.target.closest('.card[data-card]');
    const sess = e.target.closest && e.target.closest('.sess[data-session]');
    if (!card && !sess) return;
    const el = card || sess;
    S.drag = card ? { type: 'card', id: card.dataset.card } : { type: 'session', id: sess.dataset.session };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.textContent.trim().slice(0, 80));
    requestAnimationFrame(() => el.classList.add('dragging'));
  });

  main.addEventListener('dragover', (e) => {
    if (!S.drag) return;
    const body = e.target.closest('.col-body');
    if (S.drag.type === 'card') {
      if (!body) return;
      e.preventDefault();
      const cards = $$('.card[data-card]', body).filter((c) => c.dataset.card !== S.drag.id);
      const before = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      S.drag.col = body.dataset.col;
      S.drag.beforeId = before ? before.dataset.card : null;
      let line = $('.drop-line');
      if (!line) {
        line = document.createElement('div');
        line.className = 'drop-line';
      }
      if (before) body.insertBefore(line, before);
      else body.appendChild(line);
      return;
    }
    const card = e.target.closest('.card[data-card]');
    if (card || body) {
      e.preventDefault();
      clearDropMarks();
      if (card) card.classList.add('drop-target');
      else body.closest('.col').classList.add('drop-col');
    }
  });

  main.addEventListener('drop', (e) => {
    const drag = S.drag;
    if (!drag) return;
    e.preventDefault();
    const body = e.target.closest('.col-body');
    if (drag.type === 'card') {
      if (drag.col) op('card.move', { card: drag.id, status: drag.col, beforeId: drag.beforeId || undefined });
    } else {
      const card = e.target.closest('.card[data-card]');
      if (card) linkSessionsTo(card.dataset.card, [drag.id]);
      else if (body) cardFromSessions([drag.id], body.dataset.col);
    }
    clearDropMarks();
  });

  main.addEventListener('dragend', () => {
    const stale = S.drag && S.drag.stale;
    S.drag = null;
    clearDropMarks();
    for (const el of $$('.dragging')) el.classList.remove('dragging');
    if (stale) render();
  });
}
