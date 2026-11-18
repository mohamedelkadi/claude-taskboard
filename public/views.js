'use strict';
// The other three views: what is waiting on you, every session, and the
// connections graph.

// ---------- Needs me ----------

function needItem(s, kind) {
  const x = ix();
  const card = s.cardId && x.cards.get(s.cardId);
  const routine = s.routineId && x.routines.get(s.routineId);
  const text = kind === 'needs' ? (s.summary && s.summary.needsAction) || 'Waiting for your reply.' : (s.summary && s.summary.detail) || s.wrapUp || 'Ready for you to look at.';
  return `
    <div class="item">
      ${stateDot(s.estate)}
      <div class="item-body">
        <div class="item-title" data-act="session-info" data-session="${esc(s.id)}">${routine ? '⏰ ' : ''}${esc(s.title)}</div>
        <div class="item-ask">${esc(text)}</div>
        <div class="item-meta">
          ${card ? `<a class="chip" href="#card=${esc(card.key)}" data-act="open-card" data-card="${esc(card.id)}">${esc(card.key)} ${esc(card.title.slice(0, 40))}</a>` : '<span class="chip">not on a card</span>'}
          ${projChip(s.projectName)}${s.prs.slice(0, 3).map(prChip).join('')}
          <span title="${esc(fullDate(s.lastActivityAt))}">${esc(ago(s.lastActivityAt))} ago</span>
          ${routine ? `<span>${routine.runs} runs</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        <button class="btn small primary" data-act="open-session" data-session="${esc(s.id)}">Open in Claude</button>
        ${kind === 'needs' ? `<button class="btn small" data-act="ack" data-session="${esc(s.id)}" title="You dealt with it outside the session">Mark handled</button>` : ''}
      </div>
    </div>`;
}

function renderNeeds() {
  const x = ix();
  const needs = x.needs.filter(sessionMatches);
  const review = x.review.filter(sessionMatches);
  const running = x.visible.filter((s) => s.estate === 'running' && sessionMatches(s)).sort(byRecent);
  const section = (title, list, kind, empty) =>
    `<h2>${title} <span class="pill${kind === 'needs' && list.length ? ' needs' : ''}">${list.length}</span></h2>${list.length ? list.map((s) => needItem(s, kind)).join('') : `<div class="empty-state">${empty}</div>`}`;
  return `<div class="page" data-scroll="needs"><div class="page-inner">
    ${section('Waiting on you', needs, 'needs', 'Nothing is waiting on you.')}
    ${section('Ready for your review', review, 'review', 'Nothing to review.')}
    ${running.length ? section('Running now', running, 'running', '') : ''}
  </div></div>`;
}

// ---------- Sessions ----------

function sessionsList() {
  const x = ix();
  let list = S.showArchived ? S.data.sessions : x.visible.filter((s) => !s.archived);
  if (S.sessScope === 'unsorted') list = list.filter((s) => !s.cardId && (S.showArchived || !s.hidden));
  else if (S.sessScope === 'linked') list = list.filter((s) => s.cardId);
  if (S.sessState) list = list.filter((s) => s.estate === S.sessState);
  return list.filter(sessionMatches).sort(byRecent);
}

function renderSessions() {
  const x = ix();
  const list = sessionsList();
  const shown = list.slice(0, 400);
  const seg = (name, value, options) =>
    `<div class="seg">${options.map(([v, label]) => `<button class="${v === value ? 'on' : ''}" data-act="sess-filter" data-name="${name}" data-value="${v}">${label}</button>`).join('')}</div>`;
  const rows = shown
    .map((s) => {
      const card = s.cardId && x.cards.get(s.cardId);
      const parent = x.sessions.get(s.parentId || s.forkedFrom);
      const routine = s.routineId && x.routines.get(s.routineId);
      const sug = !card && s.suggest && x.cards.get(s.suggest.cardId);
      const line = s.estate === 'needs_you' && s.summary ? s.summary.needsAction : (s.summary && s.summary.detail) || '';
      const sub = [parent && `↳ from “${esc(parent.title.slice(0, 50))}”`, routine && !S.showArchived && `${routine.runs} runs`, line && esc(line), s.hidden && 'hidden', s.archived && 'archived']
        .filter(Boolean)
        .join(' · ');
      return `<tr class="${S.sel.has(s.id) ? 'sel' : ''}">
        <td><input type="checkbox" data-change="sess-pick" data-session="${esc(s.id)}"${S.sel.has(s.id) ? ' checked' : ''} aria-label="Select"></td>
        <td>${stateChip(s.estate)}</td>
        <td><div class="s-title" data-act="session-info" data-session="${esc(s.id)}">${routine ? '⏰ ' : ''}${esc(s.title)}</div>
          <div class="s-sub">${sub}</div></td>
        <td>${projChip(s.projectName)}</td>
        <td>${card ? `<a class="chip" href="#card=${esc(card.key)}" data-act="open-card" data-card="${esc(card.id)}">${esc(card.key)} ${esc(card.title.slice(0, 26))}</a>` : sug ? `<button class="suggest" data-act="accept-suggest" data-session="${esc(s.id)}" data-card="${esc(sug.id)}">→ ${esc(sug.key)} · ${esc(s.suggest.reason)}</button>` : '<span class="muted">—</span>'}</td>
        <td>${s.prs.slice(0, 3).map(prChip).join(' ')}</td>
        <td class="nowrap muted" title="${esc(fullDate(s.lastActivityAt))}">${esc(ago(s.lastActivityAt))}</td>
        <td><button class="icon-btn" data-act="open-session" data-session="${esc(s.id)}" title="Open in Claude">↗</button></td>
      </tr>`;
    })
    .join('');
  const n = S.sel.size;
  return `<div class="page" data-scroll="sessions"><div class="page-inner">
    <div class="filters">
      ${seg('sessScope', S.sessScope, [['unsorted', `Unsorted ${x.unsorted.length}`], ['linked', 'On a card'], ['all', 'All']])}
      ${seg('sessState', S.sessState, [['', 'Any state'], ['running', 'Running'], ['needs_you', 'Needs you'], ['review', 'To review'], ['done', 'Done'], ['idle', 'Idle']])}
      <label class="check"><input type="checkbox" data-change="sess-archived"${S.showArchived ? ' checked' : ''}> Include archived and hidden</label>
      <span class="grow"></span><span class="muted">${list.length} session${list.length === 1 ? '' : 's'}${list.length > shown.length ? `, first ${shown.length} shown` : ''}</span>
    </div>
    ${shown.length
      ? `<table class="sessions"><thead><tr><th><input type="checkbox" data-change="sess-pick-all"${n && shown.every((s) => S.sel.has(s.id)) ? ' checked' : ''} aria-label="Select all"></th><th>State</th><th>Session</th><th>Project</th><th>Card</th><th>PRs</th><th>Active</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty-state">${S.sessScope === 'unsorted' && !S.q && !S.sessState ? 'Every open session is on a card.' : 'No sessions match.'}</div>`}
    ${n ? `<div class="bulk"><strong>${n} selected</strong><button class="btn primary" data-act="bulk-link">Link to a card…</button><button class="btn" data-act="bulk-new">New card from ${n === 1 ? 'it' : 'them'}</button><button class="btn" data-act="bulk-unlink">Take off cards</button><button class="btn" data-act="bulk-hide">Hide</button><span class="grow"></span><button class="btn ghost" data-act="bulk-clear">Clear</button></div>` : ''}
  </div></div>`;
}

ACTIONS['sess-filter'] = (el) => {
  S[el.dataset.name] = el.dataset.value;
  render();
};
CHANGES['sess-archived'] = (el) => {
  S.showArchived = el.checked;
  render();
};
CHANGES['sess-pick'] = (el) => {
  el.checked ? S.sel.add(el.dataset.session) : S.sel.delete(el.dataset.session);
  render();
};
CHANGES['sess-pick-all'] = (el) => {
  for (const s of sessionsList().slice(0, 400)) el.checked ? S.sel.add(s.id) : S.sel.delete(s.id);
  render();
};
ACTIONS['bulk-clear'] = () => {
  S.sel.clear();
  render();
};
ACTIONS['bulk-link'] = async () => {
  const ids = [...S.sel];
  const cardId = await pickCard({ title: `Link ${ids.length} session${ids.length === 1 ? '' : 's'} to…` });
  if (!cardId) return;
  S.sel.clear();
  await linkSessionsTo(cardId, ids);
  toast('Linked.');
};
ACTIONS['bulk-new'] = async () => {
  const ids = [...S.sel];
  S.sel.clear();
  const card = await cardFromSessions(ids);
  if (card && card.id) openCard(card.id);
};
ACTIONS['bulk-unlink'] = async () => {
  const ids = [...S.sel];
  S.sel.clear();
  await op('session.unlink', { sessionIds: ids });
};
ACTIONS['bulk-hide'] = async () => {
  const ids = [...S.sel];
  S.sel.clear();
  await op('session.meta', { sessionIds: ids, hidden: true });
};

// ---------- Connections graph ----------

const G = { x: 40, y: 30, k: 1, pos: {}, sig: '', fitted: false };
try {
  G.pos = JSON.parse(localStorage.getItem('tb-graph-pos') || '{}');
} catch (_) {}
const NODE_W = 190;
const NODE_H = 62;

function graphModel() {
  const d = S.data;
  const x = ix();
  const doneCols = new Set(d.columns.filter((c) => c.done).map((c) => c.id));
  const cards = d.cards.filter((c) => !c.archived && cardMatches(c));
  const linkedIds = new Set();
  const edges = [];
  for (const c of d.cards) for (const l of c.links) edges.push({ a: c.id, b: l.to, type: l.type });
  for (const p of d.implicit) edges.push({ a: p.a, b: p.b, type: 'implicit', label: p.reasons[0], title: p.reasons.join('; ') });
  for (const e of edges) {
    linkedIds.add(e.a);
    linkedIds.add(e.b);
  }
  // done cards only earn a place when something connects to them
  const shown = cards.filter((c) => !S.graph.hideDone || !doneCols.has(c.status) || linkedIds.has(c.id));
  const ids = new Set(shown.map((c) => c.id));
  const nodes = shown.map((c) => ({ id: c.id, kind: 'card', card: c, w: NODE_W, h: NODE_H }));
  const out = edges.filter((e) => ids.has(e.a) && ids.has(e.b));
  if (S.graph.sessions) {
    const sessIds = new Set();
    for (const c of shown) {
      for (const sub of c.view.subs) {
        const s = sub.sessionId && x.sessions.get(sub.sessionId);
        if (!s || sessIds.has(s.id)) continue;
        if (sub.status === 'done' && sub.state !== 'review') continue; // open work only, or it is a hairball
        sessIds.add(s.id);
        nodes.push({ id: s.id, kind: 'session', session: s, parent: c.id, w: 130, h: 22 });
        out.push({ a: c.id, b: s.id, type: 'member' });
      }
    }
    for (const id of sessIds) {
      const s = x.sessions.get(id);
      const p = s.parentId || s.forkedFrom;
      if (p && sessIds.has(p)) out.push({ a: p, b: id, type: 'spawn' });
    }
  }
  return { nodes, edges: out };
}

/** Columns give the starting places; a short force pass pulls connected cards together. */
function layoutGraph(model) {
  const d = S.data;
  const colIndex = new Map(d.columns.map((c, i) => [c.id, i]));
  const rows = new Map();
  const P = {};
  const cardEdges = model.edges.filter((e) => e.type !== 'member' && e.type !== 'spawn');
  const connected = new Set(cardEdges.flatMap((e) => [e.a, e.b]));
  // connected cards first in each column, so a card with no connections does not sit between two that have one
  const cards = model.nodes.filter((n) => n.kind === 'card').sort((a, b) => connected.has(b.id) - connected.has(a.id));
  for (const n of cards) {
    const ci = colIndex.get(n.card.status) || 0;
    const r = rows.get(ci) || 0;
    rows.set(ci, r + 1);
    P[n.id] = { x: ci * 270, y: r * 118 + (ci % 2) * 40, ax: ci * 270 };
  }
  let k = 0;
  for (const n of model.nodes) {
    if (n.kind !== 'session') continue;
    const base = P[n.parent] || { x: 0, y: 0 };
    const angle = k++ * 2.4;
    P[n.id] = { x: base.x + 30 + Math.cos(angle) * 120, y: base.y + 20 + Math.sin(angle) * 80 };
  }
  const ids = model.nodes.map((n) => n.id);
  for (let it = 0; it < 220; it++) {
    const cool = 1 - it / 220;
    const F = {};
    for (const id of ids) F[id] = { x: 0, y: 0 };
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = P[ids[i]];
        const b = P[ids[j]];
        let dx = a.x - b.x;
        let dy = (a.y - b.y) * 1.6; // nodes are wide: push apart vertically sooner
        const dist = Math.max(20, Math.hypot(dx, dy));
        if (dist > 420) continue;
        const f = 5200 / (dist * dist);
        dx /= dist;
        dy /= dist;
        F[ids[i]].x += dx * f;
        F[ids[i]].y += dy * f;
        F[ids[j]].x -= dx * f;
        F[ids[j]].y -= dy * f;
      }
    }
    const spring = (e, len, strength) => {
      const a = P[e.a];
      const b = P[e.b];
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const f = (dist - len) * strength;
      F[e.a].x += (dx / dist) * f;
      F[e.a].y += (dy / dist) * f;
      F[e.b].x -= (dx / dist) * f;
      F[e.b].y -= (dy / dist) * f;
    };
    for (const e of cardEdges) spring(e, 250, 0.03);
    for (const e of model.edges) if (e.type === 'member') spring(e, 130, 0.08);
    for (const id of ids) {
      const p = P[id];
      if (p.ax !== undefined) F[id].x += (p.ax - p.x) * 0.02; // stay near its column
      p.x += Math.max(-30, Math.min(30, F[id].x)) * cool;
      p.y += Math.max(-30, Math.min(30, F[id].y)) * cool;
    }
  }
  // The forces only see centre points. Push apart any two cards that still
  // overlap, along whichever axis needs the smaller move.
  const GAP_X = NODE_W + 36;
  const GAP_Y = NODE_H + 46; // a two-line title makes a card taller than NODE_H
  for (let it = 0; it < 80; it++) {
    let moved = false;
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = P[cards[i].id];
        const b = P[cards[j].id];
        const ox = GAP_X - Math.abs(a.x - b.x);
        const oy = GAP_Y - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const shift = ((a.x <= b.x ? -1 : 1) * ox) / 2;
          a.x += shift;
          b.x -= shift;
        } else {
          const shift = ((a.y <= b.y ? -1 : 1) * oy) / 2;
          a.y += shift;
          b.y -= shift;
        }
      }
    }
    if (!moved) break;
  }
  return P;
}

function clipToBox(from, to, w, h) {
  // where the line from `from` to `to` leaves the box centred on `to`
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  if (!dx && !dy) return to;
  const t = Math.min(dx ? (w / 2 + 4) / Math.abs(dx) : Infinity, dy ? (h / 2 + 4) / Math.abs(dy) : Infinity);
  return { x: to.x + dx * Math.min(1, t), y: to.y + dy * Math.min(1, t) };
}

function graphEdgesSvg(model, P) {
  const size = new Map(model.nodes.map((n) => [n.id, n]));
  const centre = (id) => ({ x: P[id].x + size.get(id).w / 2, y: P[id].y + size.get(id).h / 2 });
  const parts = [];
  for (const e of model.edges) {
    if (!P[e.a] || !P[e.b]) continue;
    const ca = centre(e.a);
    const cb = centre(e.b);
    const a = clipToBox(cb, ca, size.get(e.a).w, size.get(e.a).h);
    const b = clipToBox(ca, cb, size.get(e.b).w, size.get(e.b).h);
    const arrow = e.type === 'blocks' || e.type === 'parent' ? ` marker-end="url(#arrow-${e.type})"` : '';
    parts.push(`<path class="edge ${e.type}" d="M${a.x.toFixed(1)},${a.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}"${arrow}><title>${esc(e.title || e.type)}</title></path>`);
    const label = e.type === 'blocks' ? 'blocks' : e.type === 'parent' ? 'parent of' : e.type === 'relates' ? 'related' : e.type === 'implicit' ? e.label : '';
    if (label) parts.push(`<text class="edge-label" x="${((a.x + b.x) / 2).toFixed(1)}" y="${((a.y + b.y) / 2 - 4).toFixed(1)}" text-anchor="middle">${esc(label.length > 38 ? label.slice(0, 37) + '…' : label)}</text>`);
  }
  return parts.join('');
}

let graphCtx = null;

function renderGraph(main) {
  const model = graphModel();
  const sig = model.nodes.map((n) => n.id).join(',') + '|' + model.edges.map((e) => e.a + e.b + e.type).join(',');
  const auto = layoutGraph(model);
  const P = {};
  for (const n of model.nodes) P[n.id] = G.pos[n.id] ? { ...G.pos[n.id] } : auto[n.id];
  graphCtx = { model, P };
  const x = ix();
  const nodes = model.nodes
    .map((n) => {
      const p = P[n.id];
      if (n.kind === 'session') {
        return `<div class="gsess" data-node="${esc(n.id)}" data-session="${esc(n.id)}" style="left:${p.x}px;top:${p.y}px" title="${esc(n.session.title)}">${stateDot(n.session.estate).replace('state-dot', 'state-dot')}${esc(n.session.title)}</div>`;
      }
      const c = n.card;
      const col = x.cols.get(c.status) || {};
      const cnt = c.view.counts;
      return `<div class="gnode${col.done ? ' dim' : ''}" data-node="${esc(c.id)}" data-card="${esc(c.id)}" style="left:${p.x}px;top:${p.y}px;border-top-color:${COL_COLORS[c.status] || 'var(--accent)'}">
        <div class="gm"><span class="key">${esc(c.key)}</span><span>${esc(col.name || '')}</span><span class="grow"></span>${cnt.needs ? `<span class="sig needs">${cnt.needs}</span>` : ''}${cnt.running ? `<span class="sig running">●</span>` : ''}<span>${cnt.done}/${cnt.total}</span></div>
        <div class="gt">${esc(c.title)}</div></div>`;
    })
    .join('');
  const connected = model.edges.some((e) => e.type !== 'member' && e.type !== 'spawn');
  main.innerHTML = `<div class="graph-page">
    <div class="graph-bar">
      <label class="check"><input type="checkbox" data-change="graph-sessions"${S.graph.sessions ? ' checked' : ''}> Show open sessions</label>
      <label class="check"><input type="checkbox" data-change="graph-done"${S.graph.hideDone ? ' checked' : ''}> Hide unconnected done cards</label>
      <button class="btn small" data-act="graph-fit">Fit</button><button class="btn small" data-act="graph-reset">Reset layout</button>
      <span class="grow"></span>
      <div class="legend"><span><i class="blocks"></i>blocks</span><span><i class="parent"></i>parent of</span><span><i></i>related</span><span><i class="dashed"></i>detected from sessions</span></div>
    </div>
    <div class="graph" id="graph">
      <div class="graph-inner" id="graph-inner" style="transform:translate(${G.x}px,${G.y}px) scale(${G.k})">
        <svg id="graph-svg" width="10" height="10"><defs>
          <marker id="arrow-blocks" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--danger)"/></marker>
          <marker id="arrow-parent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--running)"/></marker>
        </defs><g id="graph-edges">${graphEdgesSvg(model, P)}</g></svg>
        ${nodes}
      </div>
      ${!model.nodes.length ? '<div class="graph-empty">No cards to show.</div>' : !connected ? '<div class="graph-empty" style="align-items:flex-end;padding-bottom:26px">No connections yet. Open a card and use Connections to say what blocks or relates to what; the board also detects cards whose sessions share a PR or started one another.</div>' : ''}
    </div></div>`;
  if (!G.fitted || G.sig !== sig) {
    G.sig = sig;
    if (!G.fitted) {
      G.fitted = true;
      graphFit();
    }
  }
}

function graphApplyTransform() {
  const inner = $('#graph-inner');
  if (inner) inner.style.transform = `translate(${G.x}px,${G.y}px) scale(${G.k})`;
}

function graphFit() {
  const el = $('#graph');
  if (!el || !graphCtx || !graphCtx.model.nodes.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of graphCtx.model.nodes) {
    const p = graphCtx.P[n.id];
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + n.w);
    y1 = Math.max(y1, p.y + n.h);
  }
  const r = el.getBoundingClientRect();
  G.k = Math.max(0.3, Math.min(1.15, Math.min((r.width - 60) / Math.max(1, x1 - x0), (r.height - 60) / Math.max(1, y1 - y0))));
  G.x = (r.width - (x1 - x0) * G.k) / 2 - x0 * G.k;
  G.y = (r.height - (y1 - y0) * G.k) / 2 - y0 * G.k;
  graphApplyTransform();
}

ACTIONS['graph-fit'] = graphFit;
ACTIONS['graph-reset'] = () => {
  G.pos = {};
  try {
    localStorage.removeItem('tb-graph-pos');
  } catch (_) {}
  render();
  graphFit();
};
CHANGES['graph-sessions'] = (el) => {
  S.graph.sessions = el.checked;
  render();
  graphFit();
};
CHANGES['graph-done'] = (el) => {
  S.graph.hideDone = el.checked;
  render();
  graphFit();
};

function initGraph() {
  const main = $('#main');
  let move = null;

  main.addEventListener('pointerdown', (e) => {
    const graph = e.target.closest('#graph');
    if (!graph || e.button !== 0) return;
    const node = e.target.closest('[data-node]');
    move = node
      ? { node, id: node.dataset.node, sx: e.clientX, sy: e.clientY, ox: graphCtx.P[node.dataset.node].x, oy: graphCtx.P[node.dataset.node].y, moved: false }
      : { pan: true, sx: e.clientX, sy: e.clientY, ox: G.x, oy: G.y, moved: false };
    if (!node) graph.classList.add('panning');
    graph.setPointerCapture(e.pointerId);
  });

  main.addEventListener('pointermove', (e) => {
    if (!move) return;
    const dx = e.clientX - move.sx;
    const dy = e.clientY - move.sy;
    if (!move.moved && Math.hypot(dx, dy) < 4) return;
    move.moved = true;
    if (move.pan) {
      G.x = move.ox + dx;
      G.y = move.oy + dy;
      return graphApplyTransform();
    }
    const p = graphCtx.P[move.id];
    p.x = move.ox + dx / G.k;
    p.y = move.oy + dy / G.k;
    move.node.style.left = p.x + 'px';
    move.node.style.top = p.y + 'px';
    $('#graph-edges').innerHTML = graphEdgesSvg(graphCtx.model, graphCtx.P);
  });

  main.addEventListener('pointerup', (e) => {
    if (!move) return;
    const m = move;
    move = null;
    const graph = $('#graph');
    if (graph) graph.classList.remove('panning');
    if (m.pan) return;
    if (m.moved) {
      G.pos[m.id] = { x: graphCtx.P[m.id].x, y: graphCtx.P[m.id].y };
      try {
        localStorage.setItem('tb-graph-pos', JSON.stringify(G.pos));
      } catch (_) {}
    } else if (m.node.dataset.card) openCard(m.node.dataset.card);
    else if (m.node.dataset.session) sessionModal(m.node.dataset.session);
  });

  main.addEventListener(
    'wheel',
    (e) => {
      const graph = e.target.closest('#graph');
      if (!graph) return;
      e.preventDefault();
      const r = graph.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey) {
        const k = Math.max(0.25, Math.min(2, G.k * Math.exp(-e.deltaY * 0.01)));
        G.x = px - ((px - G.x) / G.k) * k;
        G.y = py - ((py - G.y) / G.k) * k;
        G.k = k;
      } else {
        G.x -= e.deltaX;
        G.y -= e.deltaY;
      }
      graphApplyTransform();
    },
    { passive: false }
  );
}
