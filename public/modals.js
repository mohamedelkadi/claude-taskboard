'use strict';
// Dialogs: pick a card, pick sessions, one session's details, confirm, settings.

const M = { kind: null, resolve: null, state: {} };
const INPUTS = {}; // live text handlers, by data-input

function showModal(kind, html, state) {
  if (M.resolve) M.resolve(null); // a dialog opened over another one
  M.kind = kind;
  M.state = state || {};
  M.resolve = null;
  const m = $('#modal');
  m.hidden = false;
  m.innerHTML = html;
  const first = $('[data-autofocus]', m);
  if (first) first.focus();
  return new Promise((resolve) => (M.resolve = resolve));
}

function closeModal(result) {
  const m = $('#modal');
  m.hidden = true;
  m.innerHTML = '';
  const resolve = M.resolve;
  M.kind = null;
  M.resolve = null;
  M.state = {};
  if (resolve) resolve(result === undefined ? null : result);
}

ACTIONS['modal-close'] = () => closeModal(null);

// ---------- confirm ----------

function confirmModal(title, text, okLabel) {
  return showModal(
    'confirm',
    `<div class="dialog"><div class="dlg-head">${esc(title)}</div><div class="dlg-body">${esc(text)}</div>
     <div class="dlg-foot"><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="confirm-yes" data-autofocus>${esc(okLabel || 'OK')}</button></div></div>`
  );
}
ACTIONS['confirm-yes'] = () => closeModal(true);

// ---------- pick a card ----------

function pickCardList() {
  const { q, exclude } = M.state;
  const low = q.trim().toLowerCase();
  const order = new Map(S.data.columns.map((c, i) => [c.id, i]));
  const cards = S.data.cards
    .filter((c) => !c.archived && c.id !== exclude && (!low || `${c.key} ${c.title} ${c.ticket} ${c.project}`.toLowerCase().includes(low)))
    .sort((a, b) => order.get(a.status) - order.get(b.status) || a.order - b.order)
    .slice(0, 60);
  return (
    cards
      .map(
        (c) => `<button class="pick" data-act="pick-card" data-card="${esc(c.id)}"><span class="key">${esc(c.key)}</span><span style="flex:1;min-width:0">${esc(c.title)}</span><span class="chip">${esc(colName(c.status))}</span></button>`
      )
      .join('') +
    (low ? `<button class="pick" data-act="pick-card-new">＋ New card “${esc(q.trim())}”</button>` : '') +
    (!cards.length && !low ? '<div class="muted" style="padding:8px">No cards yet. Type a title to make one.</div>' : '')
  );
}

function pickCard(opts) {
  const p = showModal(
    'pick-card',
    `<div class="dialog"><div class="dlg-head">${esc(opts.title || 'Choose a card')}<span class="grow"></span><button class="icon-btn" data-act="modal-close">✕</button></div>
     <div class="dlg-body"><input class="field" data-input="pick-card-q" data-autofocus placeholder="Search cards, or type a new title">
     <div class="pick-list" id="pick-list"></div></div></div>`,
    { q: '', exclude: opts.exclude }
  );
  $('#pick-list').innerHTML = pickCardList();
  return p;
}
INPUTS['pick-card-q'] = (el) => {
  M.state.q = el.value;
  $('#pick-list').innerHTML = pickCardList();
};
ACTIONS['pick-card'] = (el) => closeModal(el.dataset.card);
ACTIONS['pick-card-new'] = async () => {
  const title = M.state.q.trim();
  const resolve = M.resolve;
  M.resolve = null; // keep the promise open across the request
  const card = await op('card.create', { title, project: S.project || '' });
  M.resolve = resolve;
  closeModal(card && card.id ? card.id : null);
};

// ---------- pick sessions ----------

function pickSessionsList() {
  const x = ix();
  const { q, exclude, chosen, archived } = M.state;
  const low = q.trim().toLowerCase();
  let list = (archived ? S.data.sessions : x.visible.filter((s) => !s.archived)).filter((s) => s.cardId !== exclude);
  if (low) list = list.filter((s) => `${s.title} ${s.projectName} ${s.tickets.join(' ')} ${s.prs.map((p) => '#' + p.number).join(' ')}`.toLowerCase().includes(low));
  // unsorted first, then the rest, newest first within each
  list.sort((a, b) => (a.cardId ? 1 : 0) - (b.cardId ? 1 : 0) || byRecent(a, b));
  const shown = list.slice(0, 80);
  return shown.length
    ? shown
        .map((s) => {
          const card = s.cardId && x.cards.get(s.cardId);
          return `<button class="pick${chosen.has(s.id) ? ' chosen' : ''}" data-act="pick-session" data-session="${esc(s.id)}">
            <input type="checkbox" tabindex="-1"${chosen.has(s.id) ? ' checked' : ''} style="pointer-events:none;margin-top:3px">
            <span style="flex:1;min-width:0"><span style="font-weight:550">${s.routineId ? '⏰ ' : ''}${esc(s.title)}</span>
              <span class="sess-meta">${stateChip(s.estate)}${projChip(s.projectName)}<span>${esc(ago(s.lastActivityAt))}</span>${card ? `<span>on ${esc(card.key)} — linking moves it here</span>` : ''}${s.archived ? '<span>archived</span>' : ''}</span></span></button>`;
        })
        .join('') + (list.length > shown.length ? `<div class="muted" style="padding:8px">${list.length - shown.length} more — narrow the search.</div>` : '')
    : '<div class="muted" style="padding:8px">No sessions match.</div>';
}

function pickSessionsPaint() {
  $('#pick-list').innerHTML = pickSessionsList();
  const n = M.state.chosen.size;
  const btn = $('#pick-ok');
  btn.disabled = !n;
  btn.textContent = n ? `Link ${n} session${n === 1 ? '' : 's'}` : 'Link';
}

function pickSessions(opts) {
  const p = showModal(
    'pick-sessions',
    `<div class="dialog wide"><div class="dlg-head">${esc(opts.title || 'Choose sessions')}<span class="grow"></span><button class="icon-btn" data-act="modal-close">✕</button></div>
     <div class="dlg-body"><div class="add-row" style="margin:0"><input class="field" data-input="pick-sessions-q" data-autofocus placeholder="Search by title, project, ticket or PR number">
       <label class="check"><input type="checkbox" data-change="pick-archived"> Archived too</label></div>
     <div class="pick-list" id="pick-list"></div></div>
     <div class="dlg-foot"><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" id="pick-ok" data-act="pick-sessions-ok">Link</button></div></div>`,
    { q: '', exclude: opts.exclude, chosen: new Set(), archived: false }
  );
  pickSessionsPaint();
  return p;
}
INPUTS['pick-sessions-q'] = (el) => {
  M.state.q = el.value;
  pickSessionsPaint();
};
CHANGES['pick-archived'] = (el) => {
  M.state.archived = el.checked;
  pickSessionsPaint();
};
ACTIONS['pick-session'] = (el) => {
  const id = el.dataset.session;
  M.state.chosen.has(id) ? M.state.chosen.delete(id) : M.state.chosen.add(id);
  pickSessionsPaint();
};
ACTIONS['pick-sessions-ok'] = () => closeModal([...M.state.chosen]);

// ---------- one session ----------

function sessionModalHtml(s) {
  const x = ix();
  const card = s.cardId && x.cards.get(s.cardId);
  const parent = x.sessions.get(s.parentId || s.forkedFrom);
  const children = S.data.sessions.filter((c) => (c.parentId || c.forkedFrom) === s.id);
  const routine = s.routineId && x.routines.get(s.routineId);
  return `<div class="dialog wide"><div class="dlg-head">${stateChip(s.estate)}<span style="min-width:0;overflow-wrap:anywhere">${routine ? '⏰ ' : ''}${esc(s.title)}</span><span class="grow"></span><button class="icon-btn" data-act="modal-close">✕</button></div>
    <div class="dlg-body">
      <div class="sub-meta">${card ? `<a class="chip" href="#card=${esc(card.key)}" data-act="modal-open-card" data-card="${esc(card.id)}">On ${esc(card.key)} ${esc(card.title.slice(0, 40))}</a>` : '<span class="chip">Not on a card</span>'}${projChip(s.projectName)}${s.tickets.map(ticketChip).join('')}${s.prs.map(prChip).join('')}<span>active ${esc(ago(s.lastActivityAt))} ago</span>${routine ? `<span>${routine.runs} runs of this scheduled task</span>` : ''}</div>
      ${s.estate === 'needs_you' ? `<div class="sub-needs">${esc((s.summary && s.summary.needsAction) || 'Waiting for your reply.')}</div>` : ''}
      <div class="sub-detail">${sessionDetailHtml(s)}</div>
      ${parent ? `<div class="muted">Started from <a href="#" data-act="session-info" data-session="${esc(parent.id)}">${esc(parent.title)}</a></div>` : ''}
      ${children.length ? `<div class="muted">Started ${children.length} session${children.length === 1 ? '' : 's'}: ${children.slice(0, 8).map((c) => `<a href="#" data-act="session-info" data-session="${esc(c.id)}">${esc(c.title)}</a>`).join(', ')}</div>` : ''}
    </div>
    <div class="dlg-foot">
      <button class="btn ghost" data-act="copy-id" data-session="${esc(s.id)}">Copy id</button>
      <button class="btn ghost" data-act="modal-hide" data-session="${esc(s.id)}">${s.hidden ? 'Unhide' : 'Hide'}</button>
      ${card ? `<button class="btn ghost" data-act="modal-unlink" data-session="${esc(s.id)}">Take off card</button>` : ''}
      <span class="grow"></span>
      ${s.estate === 'needs_you' ? `<button class="btn" data-act="ack" data-session="${esc(s.id)}">Mark handled</button>` : ''}
      <button class="btn" data-act="modal-link" data-session="${esc(s.id)}">${card ? 'Move to another card…' : 'Link to a card…'}</button>
      ${openButton(s, 'primary')}
    </div></div>`;
}

function sessionModal(id) {
  const s = ix().sessions.get(id);
  if (!s) return;
  showModal('session', sessionModalHtml(s), { id });
}

function refreshSessionModal(id) {
  if (M.kind !== 'session' || (id && M.state.id !== id)) return;
  const s = ix().sessions.get(M.state.id);
  if (!s) return closeModal(null);
  $('#modal').innerHTML = sessionModalHtml(s);
}

ACTIONS['modal-open-card'] = (el) => {
  closeModal(null);
  openCard(el.dataset.card);
};
ACTIONS['modal-link'] = async (el) => {
  const id = el.dataset.session;
  const cardId = await pickCard({ title: 'Link this session to…', exclude: (ix().sessions.get(id) || {}).cardId });
  if (cardId) {
    await linkSessionsTo(cardId, [id]);
    toast('Linked.');
  }
};
ACTIONS['modal-unlink'] = (el) => op('session.unlink', { sessionIds: [el.dataset.session] });
ACTIONS['modal-hide'] = (el) => {
  const s = ix().sessions.get(el.dataset.session);
  if (s) op('session.meta', { sessionIds: [s.id], hidden: !s.hidden });
};

// ---------- settings ----------

function settingsHtml() {
  const d = S.data;
  const st = M.state;
  const archived = d.cards.filter((c) => c.archived);
  const hidden = d.sessions.filter((s) => s.hidden).length;
  return `<div class="dialog wide"><div class="dlg-head">Settings<span class="grow"></span><button class="icon-btn" data-act="modal-close">✕</button></div>
    <div class="dlg-body">
      <div class="form-row"><span>Columns</span>
        <div id="col-list">${st.cols
          .map(
            (c, i) => `<div class="col-edit"><input class="field" data-input="col-name" data-i="${i}" value="${esc(c.name)}" placeholder="Column name">
              <label class="check" title="Cards here count as finished"><input type="checkbox" data-change="col-done" data-i="${i}"${c.done ? ' checked' : ''}> done</label>
              <button class="icon-btn" data-act="col-move" data-i="${i}" data-d="-1" title="Move left"${i === 0 ? ' disabled' : ''}>←</button>
              <button class="icon-btn" data-act="col-move" data-i="${i}" data-d="1" title="Move right"${i === st.cols.length - 1 ? ' disabled' : ''}>→</button>
              <button class="icon-btn" data-act="col-del" data-i="${i}" title="Delete column"${st.cols.length === 1 ? ' disabled' : ''}>✕</button></div>`
          )
          .join('')}</div>
        <div><button class="btn small" data-act="col-add">＋ Add column</button></div>
        <div class="help">Cards in a column you delete move to the first column.</div>
      </div>
      <div class="form-row"><span>Ticket links</span>
        <input class="field" data-input="set-ticket" value="${esc(st.ticketUrl)}" placeholder="https://yourcompany.atlassian.net/browse/{key}">
        <div class="help">Ticket keys on cards and sessions open this address, with {key} replaced.</div>
      </div>
      <div class="form-row"><span>Automation</span>
        <label class="check"><input type="checkbox" data-change="set-follow"${st.followSessions ? ' checked' : ''}> A card that has not started moves to In progress when one of its sessions starts working</label>
        <label class="check"><input type="checkbox" data-change="set-inherit"${st.inheritChildren ? ' checked' : ''}> A session started from a session on a card joins that card</label>
        <label class="check"><input type="checkbox" data-change="set-autostart"${st.autostart ? ' checked' : ''}> Start the board whenever a Claude session starts</label>
      </div>
      ${archived.length ? `<div class="form-row"><span>Archived cards</span>${archived.map((c) => `<div class="conn"><span class="ct"><span class="key">${esc(c.key)}</span> ${esc(c.title)}</span><button class="btn small" data-act="card-restore" data-card="${esc(c.id)}">Restore</button></div>`).join('')}</div>` : ''}
      <div class="form-row"><span>Data</span>
        <div class="help">The board is one file: <code class="path">${esc(d.paths.board.replace(/^\/Users\/[^/]+/, '~'))}</code>. Sessions are read from Claude's own files and never changed.</div>
        <div class="row-actions"><button class="btn small" data-act="reveal">Open the folder</button><a class="btn small" href="/api/export">Export board</a><button class="btn small" data-act="rescan">Rescan sessions now</button>${hidden ? `<button class="btn small" data-act="unhide-all">Unhide ${hidden} hidden session${hidden === 1 ? '' : 's'}</button>` : ''}</div>
      </div>
    </div>
    <div class="dlg-foot"><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="settings-save">Save</button></div></div>`;
}

ACTIONS.settings = () => {
  const d = S.data;
  showModal('settings', '', { cols: d.columns.map((c) => ({ ...c })), ticketUrl: d.settings.ticketUrl || '', inheritChildren: d.settings.inheritChildren !== false, autostart: d.settings.autostart !== false, followSessions: d.settings.followSessions !== false });
  $('#modal').innerHTML = settingsHtml();
};
const repaintSettings = () => (M.kind === 'settings' ? ($('#modal').innerHTML = settingsHtml()) : null);
INPUTS['col-name'] = (el) => (M.state.cols[+el.dataset.i].name = el.value);
INPUTS['set-ticket'] = (el) => (M.state.ticketUrl = el.value);
CHANGES['col-done'] = (el) => (M.state.cols[+el.dataset.i].done = el.checked);
CHANGES['set-inherit'] = (el) => (M.state.inheritChildren = el.checked);
CHANGES['set-follow'] = (el) => (M.state.followSessions = el.checked);
CHANGES['set-autostart'] = (el) => (M.state.autostart = el.checked);
ACTIONS['col-add'] = () => {
  M.state.cols.push({ name: 'New column' });
  repaintSettings();
};
ACTIONS['col-del'] = (el) => {
  M.state.cols.splice(+el.dataset.i, 1);
  repaintSettings();
};
ACTIONS['col-move'] = (el) => {
  const i = +el.dataset.i;
  const j = i + +el.dataset.d;
  const cols = M.state.cols;
  if (j < 0 || j >= cols.length) return;
  [cols[i], cols[j]] = [cols[j], cols[i]];
  repaintSettings();
};
ACTIONS['settings-save'] = async () => {
  const st = M.state;
  const cols = st.cols.filter((c) => c.name.trim());
  const okCols = await op('columns.set', { columns: cols });
  const okSet = okCols && (await op('settings.update', { ticketUrl: st.ticketUrl.trim(), inheritChildren: st.inheritChildren, autostart: st.autostart, followSessions: st.followSessions }));
  if (okSet) {
    closeModal(null);
    toast('Saved.');
  }
};
ACTIONS['card-restore'] = async (el) => {
  await op('card.update', { card: el.dataset.card, archived: false });
  repaintSettings();
};
ACTIONS['unhide-all'] = async () => {
  await op('session.meta', { sessionIds: S.data.sessions.filter((s) => s.hidden).map((s) => s.id), hidden: false });
  repaintSettings();
};
ACTIONS.reveal = () => post('/api/reveal', {});
ACTIONS.rescan = async () => {
  const j = await post('/api/rescan', {}).catch(() => null);
  if (j && j.ok) {
    setData(j.state);
    toast('Rescanned.');
  }
};
