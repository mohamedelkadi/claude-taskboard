'use strict';
// The card panel: fields, sub-tasks (checklist items and linked sessions),
// connections to other cards, the rules that pull sessions in, and notes.

const REL_OUT = { blocks: 'Blocks', parent: 'Parent of', relates: 'Related to' };
const REL_IN = { blocks: 'Blocked by', parent: 'Part of', relates: 'Related to' };
const VIA = { group: 'filed in the same sidebar group', ticket: 'mentions the card’s ticket', child: 'started from a session on this card', family: 'imported with the sessions it started from', claude: 'linked by Claude', manual: '' };

// ---------- session detail (step list, outcome), fetched on demand ----------

function ensureDetail(id) {
  const s = ix().sessions.get(id);
  if (!s) return;
  const have = S.details.get(id);
  if (have && (have.loading || have.at === s.lastActivityAt)) return;
  S.details.set(id, { ...(have || {}), loading: true, at: s.lastActivityAt });
  fetch('/api/session?id=' + encodeURIComponent(id))
    .then((r) => r.json())
    .then((j) => S.details.set(id, { at: s.lastActivityAt, detail: j.ok ? j.detail : null }))
    .catch(() => S.details.set(id, { at: s.lastActivityAt, detail: null }))
    .then(() => {
      renderDrawer();
      refreshSessionModal(id);
    });
}

function sessionDetailHtml(s) {
  ensureDetail(s.id);
  const entry = S.details.get(s.id);
  const det = entry && entry.detail;
  const parts = [];
  if (s.estate !== 'needs_you' && s.summary && s.summary.detail) parts.push(`<div><h5>Where it stands</h5>${esc(s.summary.detail)}</div>`);
  if (det && det.plan.length) {
    const mark = { completed: '✓', in_progress: '▶', pending: '○' };
    parts.push(`<div><h5>Steps (${det.plan.filter((i) => i.status === 'completed').length}/${det.plan.length})</h5><ul class="steps">${det.plan
      .map((i) => `<li class="${esc(i.status)}"><span class="mark">${mark[i.status] || '○'}</span><span>${esc(i.content)}</span></li>`)
      .join('')}</ul></div>`);
  }
  const outcome = (det && det.wrap && det.wrap.recap) || s.wrapUp || s.lastReport;
  if (outcome) parts.push(`<div><h5>Outcome</h5>${esc(outcome)}</div>`);
  if (det && det.wrap && det.wrap.ask) parts.push(`<div><h5>It asked</h5>${esc(det.wrap.ask)}</div>`);
  if (det && det.firstPrompt) parts.push(`<div><h5>Started with</h5><div class="quote">${esc(det.firstPrompt)}</div></div>`);
  if (s.artifacts.length) {
    parts.push(`<div><h5>Pages it published</h5>${s.artifacts
      .filter((a) => /^https:\/\//.test(a.url))
      .map((a) => `<a class="chip" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title || 'Artifact')}</a>`)
      .join(' ')}</div>`);
  }
  const facts = [s.projectName, s.branch && `branch ${s.branch}`, s.model, `started ${fullDate(s.createdAt)}`, det && det.cost ? `$${det.cost.toFixed(2)}` : '', s.archived ? 'archived in Claude' : ''].filter(Boolean);
  parts.push(`<div class="muted">${facts.map(esc).join(' · ')}</div>`);
  if (!det && entry && entry.loading) parts.unshift('<div class="muted">Reading the session…</div>');
  if (s.error) parts.push(`<div class="muted">Last error: ${esc(s.error)}</div>`);
  return parts.join('');
}

// ---------- sub-task rows ----------

function subRow(card, sub) {
  const x = ix();
  const s = sub.sessionId ? x.sessions.get(sub.sessionId) : null;
  const linked = sub.kind !== 'manual';
  const open = S.expanded.has(sub.id);
  const options = (linked ? [['auto', `${SUB_LABEL[sub.status]} · auto`]] : []).concat(Object.entries(SUB_LABEL));
  const current = linked && sub.auto ? 'auto' : sub.status;
  const select = `<select class="sub-status s-${esc(sub.status)}" data-change="sub-status" data-sub="${esc(sub.id)}" data-keep="st-${esc(sub.id)}" title="${linked ? 'Follows the session unless you pick a status' : 'Status'}">${options
    .map(([v, label]) => `<option value="${v}"${v === current ? ' selected' : ''}>${esc(label)}</option>`)
    .join('')}</select>`;

  let title;
  if (!linked && S.editSub === sub.id) {
    title = `<input class="field sub-title-edit" data-keep="sub-${esc(sub.id)}" data-commit="sub-title" data-sub="${esc(sub.id)}" value="${esc(sub.title)}">`;
  } else if (linked) {
    title = `<div class="sub-title" data-act="sub-toggle" data-sub="${esc(sub.id)}">${sub.kind === 'routine' ? '⏰ ' : ''}${esc(sub.title)}</div>`;
  } else {
    title = `<div class="sub-title" data-act="sub-edit" data-sub="${esc(sub.id)}" title="Click to rename">${esc(sub.title)}</div>`;
  }

  let meta = '';
  let needs = '';
  let detail = '';
  if (linked && s) {
    const bits = [stateChip(sub.state)];
    if (sub.kind === 'routine') bits.push(`<span>${sub.runs} runs · latest shown</span>`);
    if (s.projectName && s.projectName !== card.project) bits.push(projChip(s.projectName));
    if (s.steps) bits.push(`<span title="${esc(s.steps.current || '')}">${s.steps.done}/${s.steps.total} steps</span>`);
    bits.push(`<span title="${esc(fullDate(s.lastActivityAt))}">${esc(ago(s.lastActivityAt))}</span>`);
    bits.push(s.prs.slice(0, 4).map(prChip).join(''));
    if (s.archived) bits.push('<span>archived</span>');
    if (VIA[sub.via]) bits.push(`<span title="Why it is on this card">· ${esc(VIA[sub.via])}</span>`);
    meta = `<div class="sub-meta">${bits.join('')}</div>`;
    if (sub.state === 'needs_you') {
      needs = `<div class="sub-needs">${esc((s.summary && s.summary.needsAction) || 'Waiting for your reply.')}
        <div class="row-actions" style="margin-top:6px"><button class="btn small" data-act="open-session" data-session="${esc(s.id)}">Open in Claude</button><button class="btn small ghost" data-act="ack" data-session="${esc(s.id)}">Mark handled</button></div></div>`;
    }
    if (open) {
      detail = `<div class="sub-detail">${sessionDetailHtml(s)}
        <div class="row-actions"><button class="btn small" data-act="open-session" data-session="${esc(s.id)}">Open in Claude</button><button class="btn small ghost" data-act="copy-id" data-session="${esc(s.id)}">Copy session id</button><button class="btn small ghost danger" data-act="sub-remove" data-sub="${esc(sub.id)}">Take off this card</button></div></div>`;
    }
  } else if (linked) {
    meta = `<div class="sub-meta"><span>${sub.kind === 'routine' ? 'This scheduled task has no runs on this Mac.' : 'The session was deleted from Claude.'}</span></div>`;
  }

  const buttons = linked
    ? `${s ? `<button class="icon-btn" data-act="open-session" data-session="${esc(s.id)}" title="Open in Claude">↗</button>` : ''}<button class="icon-btn" data-act="${s ? 'sub-toggle' : 'sub-remove'}" data-sub="${esc(sub.id)}" title="${s ? 'Details' : 'Remove'}">${s ? (open ? '▴' : '▾') : '✕'}</button>`
    : `<button class="icon-btn" data-act="sub-remove" data-sub="${esc(sub.id)}" title="Remove">✕</button>`;

  return `<div class="sub${sub.status === 'done' ? ' is-done' : ''}${linked ? ' linked' : ''}${open ? ' expanded' : ''}">${select}<div class="sub-main">${title}${meta}${needs}${detail}</div>${buttons}</div>`;
}

// ---------- the panel ----------

function connectionRows(card) {
  const x = ix();
  const rows = [];
  for (const l of card.links) {
    const o = x.cards.get(l.to);
    if (o) rows.push({ rel: REL_OUT[l.type] || 'Related to', o, from: card.id, to: o.id });
  }
  for (const o of S.data.cards) {
    for (const l of o.links) if (l.to === card.id) rows.push({ rel: REL_IN[l.type] || 'Related to', o, from: o.id, to: card.id });
  }
  const html = rows.map(
    (r) => `<div class="conn"><span class="rel">${esc(r.rel)}</span><span class="ct" data-act="open-card" data-card="${esc(r.o.id)}"><span class="key">${esc(r.o.key)}</span> ${esc(r.o.title)}</span><span class="chip">${esc(colName(r.o.status))}</span><button class="icon-btn" data-act="conn-remove" data-from="${esc(r.from)}" data-to="${esc(r.to)}" title="Remove connection">✕</button></div>`
  );
  for (const p of S.data.implicit) {
    if (p.a !== card.id && p.b !== card.id) continue;
    const o = x.cards.get(p.a === card.id ? p.b : p.a);
    if (!o) continue;
    html.push(
      `<div class="conn detected"><span class="rel">Possibly related</span><span class="ct" data-act="open-card" data-card="${esc(o.id)}"><span class="key">${esc(o.key)}</span> ${esc(o.title)}</span><span class="why" title="${esc(p.reasons.join('; '))}">${esc(p.reasons.join('; '))}</span><button class="btn small" data-act="conn-accept" data-to="${esc(o.id)}">Connect</button></div>`
    );
  }
  return html.join('');
}

function drawerHtml(card) {
  const d = S.data;
  const x = ix();
  const v = card.view;
  const open = v.subs.filter((s) => s.status !== 'done');
  const done = v.subs.filter((s) => s.status === 'done');
  const pct = v.counts.total ? Math.round((v.counts.done / v.counts.total) * 100) : 0;
  const auto = card.auto || {};

  const desc = S.editDesc
    ? `<textarea class="field desc-edit" data-keep="desc" data-commit="card-desc" placeholder="The goal, the context, what done looks like. Markdown works.">${esc(card.description)}</textarea>
       <div class="help">Saved when you click away. Esc cancels.</div>`
    : `<div class="desc${card.description.trim() ? '' : ' empty'}" data-act="edit-desc">${card.description.trim() ? md(card.description) : 'Add a description: the goal, the context, what done looks like.'}</div>`;

  const notes = card.notes
    .slice()
    .reverse()
    .map(
      (n) => `<div class="note"><div class="note-head"><strong>${esc(n.by === 'me' ? 'You' : n.by)}</strong><span>${esc(fullDate(n.at))}</span><span class="grow"></span><button class="icon-btn" data-act="note-remove" data-note="${esc(n.id)}" title="Delete note">✕</button></div>${md(n.text)}</div>`
    )
    .join('');

  return `
    <div class="d-head">
      <span class="key">${esc(card.key)}</span>
      <select class="field" data-change="card-status" data-keep="card-status" title="Column">${d.columns.map((c) => `<option value="${esc(c.id)}"${c.id === card.status ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select class="field" data-change="card-priority" data-keep="card-priority" title="Priority">${Object.entries(PRIO_LABEL).map(([k, l]) => `<option value="${k}"${k === card.priority ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <span class="grow"></span>
      <button class="btn small primary" data-act="start-session" title="Open a new Claude session with this card's brief already in the prompt box">Start a session</button>
      <button class="btn small ghost" data-act="copy-brief" title="Copy the brief instead, to paste into a session yourself">Copy brief</button>
      <button class="btn small ghost" data-act="card-archive">${card.archived ? 'Restore' : 'Archive'}</button>
      <button class="btn small ghost danger" data-act="card-delete">Delete</button>
      <button class="icon-btn" data-act="close-card" title="Close (Esc)">✕</button>
    </div>
    <div class="d-body" data-scroll="drawer">
      <textarea class="d-title" rows="1" data-keep="title" data-commit="card-title" spellcheck="false">${esc(card.title)}</textarea>
      <div class="d-meta">
        <label>Project<input class="field" list="projects" data-keep="project" data-commit="card-project" value="${esc(card.project)}" placeholder="—"></label>
        <label>Ticket<input class="field" data-keep="ticket" data-commit="card-ticket" value="${esc(card.ticket)}" placeholder="e.g. PROJ-3883"></label>
        <label>Tags<input class="field" data-keep="tags" data-commit="card-tags" value="${esc(card.tags.join(', '))}" placeholder="comma separated"></label>
        <label>Due<input class="field" type="date" data-keep="due" data-change="card-due" value="${esc(card.due || '')}"></label>
      </div>
      <datalist id="projects">${x.projects.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      ${card.ticket || v.tickets.length ? `<div class="sub-meta" style="margin-top:6px">${[...new Set([card.ticket, ...v.tickets].filter(Boolean))].map(ticketChip).join('')}${v.prs.map(prChip).join('')}</div>` : v.prs.length ? `<div class="sub-meta" style="margin-top:6px">${v.prs.map(prChip).join('')}</div>` : ''}

      <div class="sec"><div class="sec-head"><h4>Description</h4></div>${desc}</div>

      <div class="sec">
        <div class="sec-head"><h4>Sub-tasks</h4><span class="muted">${v.counts.done}/${v.counts.total}</span>${v.counts.total ? `<div class="bar" style="max-width:160px"><i style="width:${pct}%"></i></div>` : ''}</div>
        ${open.map((s) => subRow(card, s)).join('')}
        ${!v.subs.length ? '<div class="muted" style="padding:4px 8px">No sub-tasks yet. Add checklist items, or link the Claude sessions doing the work.</div>' : ''}
        ${done.length ? `<button class="fold" data-act="toggle-done-subs">${S.showDoneSubs ? '▾ Hide' : '▸ Show'} ${done.length} done</button>${S.showDoneSubs ? done.map((s) => subRow(card, s)).join('') : ''}` : ''}
        <div class="add-row">
          <input class="field" id="new-sub" data-keep="new-sub" data-enter="add-sub" placeholder="Add a sub-task and press Enter">
          <button class="btn" data-act="link-sessions">Link sessions…</button>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head"><h4>Connections</h4></div>
        ${connectionRows(card) || '<div class="muted" style="padding:4px 8px">Not connected to other cards.</div>'}
        <div class="add-row">
          <select class="field" id="conn-type" data-keep="conn-type" style="flex:none;width:130px">
            <option value="blocks">Blocks</option><option value="blocked">Blocked by</option><option value="parent">Parent of</option><option value="child">Part of</option><option value="relates" selected>Related to</option>
          </select>
          <button class="btn" data-act="conn-add">Choose a card…</button>
        </div>
      </div>

      <div class="sec">
        <button class="fold" style="padding-left:0" data-act="toggle-auto">${S.showAuto ? '▾' : '▸'} Which sessions join this card on their own</button>
        ${S.showAuto ? `<div class="auto-box">
          <label><input type="checkbox" data-change="auto-inherit"${auto.inheritChildren === false ? '' : ' checked'}> Sessions started from a session already on this card</label>
          <label>Sessions filed in the Claude sidebar group
            <select class="field" data-change="auto-group" data-keep="auto-group"><option value="">none</option>${d.groups.map((g) => `<option value="${esc(g.id)}"${g.id === auto.groupId ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
          <label>Sessions whose title or branch mentions
            <input class="field" data-keep="auto-tickets" data-commit="auto-tickets" value="${esc((auto.ticketKeys || []).join(', '))}" placeholder="ticket keys, e.g. PROJ-3883"></label>
          <div class="help">A session you take off the card by hand is not added back.</div>
        </div>` : ''}
      </div>

      <div class="sec">
        <div class="sec-head"><h4>Notes</h4><span class="muted">${card.notes.length || ''}</span></div>
        <div class="add-row" style="margin:0 0 8px"><textarea class="field" id="new-note" data-keep="new-note" rows="2" placeholder="A decision, a finding, where this stands. Claude sessions on this card read and add notes too." style="resize:vertical"></textarea><button class="btn" data-act="note-add" style="align-self:flex-end">Add</button></div>
        ${notes}
      </div>

      <div class="d-foot">
        <span>Claude reads this card from</span><code class="path">~/.claude/taskboard/cards/${esc(card.key)}.md</code>
        <button class="btn small ghost" data-act="copy-path">Copy path</button>
        <span class="grow"></span><span>Created ${esc(fullDate(card.createdAt))}</span>
      </div>
    </div>`;
}

function renderDrawer() {
  const el = $('#drawer');
  const card = S.data && S.cardId && ix().cards.get(S.cardId);
  if (!card) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  swap(el, drawerHtml(card));
  const title = $('.d-title', el);
  if (title) {
    title.style.height = 'auto';
    title.style.height = title.scrollHeight + 'px';
  }
}

const currentCard = () => S.cardId && ix().cards.get(S.cardId);
const cardOp = (name, args) => op(name, { card: S.cardId, ...args });

// ---------- handlers ----------

CHANGES['card-status'] = (el) => cardOp('card.update', { status: el.value });
CHANGES['card-priority'] = (el) => cardOp('card.update', { priority: el.value });
CHANGES['card-due'] = (el) => cardOp('card.update', { due: el.value || null });
CHANGES['sub-status'] = (el) => cardOp('subtask.update', { subtask: el.dataset.sub, status: el.value });
CHANGES['auto-inherit'] = (el) => cardOp('card.update', { auto: { inheritChildren: el.checked } });
CHANGES['auto-group'] = (el) => cardOp('card.update', { auto: { groupId: el.value } });

COMMITS['card-title'] = (el) => {
  const card = currentCard();
  const v = el.value.replace(/\s+/g, ' ').trim();
  if (!card || !v || v === card.title) return void (el.value = card ? card.title : '');
  cardOp('card.update', { title: v });
};
COMMITS['card-project'] = (el) => {
  const card = currentCard();
  if (card && el.value.trim() !== card.project) cardOp('card.update', { project: el.value });
};
COMMITS['card-ticket'] = (el) => {
  const card = currentCard();
  const v = el.value.trim().toUpperCase();
  if (!card || v === card.ticket) return;
  // naming a ticket also pulls in sessions that mention it
  const keys = [...new Set([...(card.auto.ticketKeys || []).filter((k) => k !== card.ticket), v].filter(Boolean))];
  cardOp('card.update', { ticket: v, auto: { ticketKeys: keys } });
};
COMMITS['card-tags'] = (el) => {
  const card = currentCard();
  if (card && el.value.split(',').map((t) => t.trim()).filter(Boolean).join(',') !== card.tags.join(',')) cardOp('card.update', { tags: el.value });
};
COMMITS['card-desc'] = (el) => {
  const card = currentCard();
  S.editDesc = false;
  if (card && el.value !== card.description) cardOp('card.update', { description: el.value });
  else renderWhenSafe();
};
COMMITS['sub-title'] = (el) => {
  const card = currentCard();
  const sub = card && card.view.subs.find((s) => s.id === el.dataset.sub);
  S.editSub = null;
  const v = el.value.trim();
  if (sub && v && v !== sub.title) cardOp('subtask.update', { subtask: sub.id, title: v });
  else renderWhenSafe();
};
COMMITS['auto-tickets'] = (el) => {
  const card = currentCard();
  const keys = el.value.split(/[,\s]+/).map((k) => k.trim().toUpperCase()).filter(Boolean);
  if (card && keys.join(',') !== (card.auto.ticketKeys || []).join(',')) cardOp('card.update', { auto: { ticketKeys: keys } });
};

ACTIONS['edit-desc'] = (_el, e) => {
  if (e.target.closest('a')) return; // a link inside the description
  S.editDesc = true;
  renderDrawer();
  const ta = $('.desc-edit');
  if (ta) ta.focus();
};
ACTIONS['sub-toggle'] = (el) => {
  const id = el.dataset.sub;
  S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
  renderDrawer();
};
ACTIONS['sub-edit'] = (el) => {
  S.editSub = el.dataset.sub;
  renderDrawer();
  const input = $('.sub-title-edit');
  if (input) {
    input.focus();
    input.select();
  }
};
ACTIONS['sub-remove'] = (el) => cardOp('subtask.remove', { subtask: el.dataset.sub });
ACTIONS['toggle-done-subs'] = () => {
  S.showDoneSubs = !S.showDoneSubs;
  renderDrawer();
};
ACTIONS['toggle-auto'] = () => {
  S.showAuto = !S.showAuto;
  renderDrawer();
};
ACTIONS['add-sub'] = async () => {
  const input = $('#new-sub');
  const title = input ? input.value.trim() : '';
  if (!title) return;
  input.value = '';
  await cardOp('subtask.add', { title });
  const again = $('#new-sub');
  if (again) again.focus();
};
ACTIONS['link-sessions'] = async () => {
  const cardId = S.cardId;
  const ids = await pickSessions({ title: 'Link sessions to this card', exclude: cardId });
  if (ids && ids.length) linkSessionsTo(cardId, ids);
};
ACTIONS['conn-remove'] = (el) => op('link.remove', { from: el.dataset.from, to: el.dataset.to });
ACTIONS['conn-accept'] = (el) => op('link.add', { from: S.cardId, to: el.dataset.to, type: 'relates' });
ACTIONS['conn-add'] = async () => {
  const kind = $('#conn-type').value;
  const here = S.cardId;
  const other = await pickCard({ title: `${{ blocks: 'Blocks', blocked: 'Blocked by', parent: 'Parent of', child: 'Part of', relates: 'Related to' }[kind]}…`, exclude: here });
  if (!other) return;
  if (kind === 'blocked') op('link.add', { from: other, to: here, type: 'blocks' });
  else if (kind === 'child') op('link.add', { from: other, to: here, type: 'parent' });
  else op('link.add', { from: here, to: other, type: kind });
};
ACTIONS['note-add'] = async () => {
  const ta = $('#new-note');
  const text = ta ? ta.value.trim() : '';
  if (!text) return;
  ta.value = '';
  await cardOp('note.add', { text });
};
ACTIONS['note-remove'] = (el) => cardOp('note.remove', { noteId: el.dataset.note });
ACTIONS['card-archive'] = async () => {
  const card = currentCard();
  if (!card) return;
  const was = card.archived;
  if (await cardOp('card.update', { archived: !was })) {
    toast(was ? 'Card restored.' : 'Card archived. Restore it from Settings.');
    if (!was) closeCard();
  }
};
ACTIONS['card-delete'] = async () => {
  const card = currentCard();
  if (!card) return;
  const n = card.view.subs.filter((s) => s.kind !== 'manual').length;
  const yes = await confirmModal(`Delete ${card.key} “${card.title}”?`, `The card, its checklist and its notes are removed for good.${n ? ` Its ${n} linked session${n === 1 ? '' : 's'} stay in Claude and go back to Unsorted.` : ''}`, 'Delete card');
  if (yes && (await op('card.delete', { card: card.id }))) toast('Card deleted.');
};
ACTIONS['start-session'] = async () => {
  const card = currentCard();
  if (!card) return;
  const j = await post('/api/new-session', { card: card.key }).catch(() => null);
  if (!j || !j.ok) return toast((j && j.error) || 'Could not open the Claude app.', 'error');
  await copyText(j.brief); // so it can be pasted if Claude opens without it
  toast('Claude is opening a new session with the brief filled in (it is on your clipboard too). Pick the folder, finish the sentence, send.');
};
ACTIONS['copy-brief'] = async () => {
  const card = currentCard();
  if (!card) return;
  const j = await post('/api/new-session', { card: card.key, copyOnly: true }).catch(() => null);
  if (!j || !j.ok) return toast('Could not build the brief.', 'error');
  await copyText(j.brief);
  toast('Brief copied. Paste it into a Claude session and finish the sentence.');
};
ACTIONS['copy-path'] = async () => {
  const card = currentCard();
  if (card) {
    await copyText(`~/.claude/taskboard/cards/${card.key}.md`);
    toast('Path copied.');
  }
};
ACTIONS['copy-id'] = async (el) => {
  await copyText(el.dataset.session);
  toast('Session id copied.');
};
