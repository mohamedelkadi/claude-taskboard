'use strict';
// Joins the board with what the scan found: effective sub-task statuses,
// per-card counts, detected connections, the automatic linking rules, the
// first-run import, and the Markdown copies of each card that Claude reads.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const store = require('./store');

const SUB_FROM_STATE = { running: 'in_progress', needs_you: 'blocked', review: 'review', done: 'done', idle: 'in_progress' };
const STATE_LABEL = { running: 'running', needs_you: 'needs you', review: 'ready for review', done: 'done', idle: 'idle' };
const SUB_LABEL = { todo: 'to do', in_progress: 'in progress', blocked: 'blocked', review: 'in review', done: 'done' };
const DAY = 86400000;

/** The token that identifies "the thing this session is currently asking for". */
function ackToken(s) {
  return (s.summary && s.summary.uuid) || String(s.lastActivityAt);
}

/** A session's state as the board shows it (archived and acknowledged requests settle). */
function effectiveState(s, meta) {
  if (s.state === 'running') return 'running';
  if (s.archived) return 'done'; // archiving a session is the user saying it is finished
  if (s.state === 'needs_you' && meta && meta.ack && meta.ack === ackToken(s)) return 'idle';
  return s.state;
}

function buildRoutines(sessions) {
  const routines = new Map();
  for (const s of sessions) {
    if (!s.routineId) continue;
    let r = routines.get(s.routineId);
    if (!r) routines.set(s.routineId, (r = { id: s.routineId, title: s.title, runs: [] }));
    r.runs.push(s);
  }
  for (const r of routines.values()) {
    r.runs.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    r.latest = r.runs[0];
    r.title = r.latest.title;
  }
  return routines;
}

function effectiveSub(sub, ctx) {
  if (sub.sessionId) {
    const s = ctx.byId.get(sub.sessionId);
    if (!s) {
      return { id: sub.id, kind: 'session', sessionId: sub.sessionId, missing: true, auto: sub.status === 'auto', status: sub.status === 'auto' ? 'done' : sub.status, title: sub.title || 'Session no longer on this Mac', via: sub.via || '' };
    }
    return {
      id: sub.id, kind: 'session', sessionId: s.id, auto: sub.status === 'auto', state: s.estate,
      status: sub.status === 'auto' ? SUB_FROM_STATE[s.estate] : sub.status,
      title: sub.title || s.title, via: sub.via || '',
    };
  }
  if (sub.routineId) {
    const r = ctx.routines.get(sub.routineId);
    if (!r) return { id: sub.id, kind: 'routine', routineId: sub.routineId, missing: true, auto: sub.status === 'auto', status: sub.status === 'auto' ? 'todo' : sub.status, title: sub.title || sub.routineId };
    const s = r.latest;
    return {
      id: sub.id, kind: 'routine', routineId: r.id, sessionId: s.id, runs: r.runs.length, auto: sub.status === 'auto', state: s.estate,
      // a routine is never "done": a finished run just means it is ticking over
      status: sub.status === 'auto' ? (s.estate === 'needs_you' ? 'blocked' : 'in_progress') : sub.status,
      title: sub.title || r.title,
    };
  }
  return { id: sub.id, kind: 'manual', status: sub.status, title: sub.title };
}

/**
 * Everything the UI, the MCP tools and the CLI show, computed in one place.
 * `scanResult` is what claude.scan() returned.
 */
function buildState(board, scanResult) {
  const meta = board.sessionMeta;
  const sessions = scanResult.sessions;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    s.estate = effectiveState(s, meta[s.id]);
    s.token = ackToken(s);
    s.cardId = null;
    s.hidden = !!(meta[s.id] && meta[s.id].hidden);
  }
  const routines = buildRoutines(sessions);
  const ctx = { byId, routines };
  const routineCard = new Map();

  const cards = board.cards.map((card) => {
    const subs = card.subtasks.map((sub) => effectiveSub(sub, ctx));
    const counts = { total: subs.length, done: 0, running: 0, needs: 0, review: 0 };
    const prs = new Map();
    const tickets = new Set(card.ticket ? [card.ticket] : []);
    let lastActivityAt = 0;
    for (const sub of subs) {
      if (sub.status === 'done') counts.done++;
      if (sub.state === 'running') counts.running++;
      if (sub.state === 'needs_you') counts.needs++;
      if (sub.state === 'review') counts.review++;
      if (sub.kind === 'routine') routineCard.set(sub.routineId, card.id);
      const s = sub.sessionId && byId.get(sub.sessionId);
      if (!s) continue;
      if (sub.kind === 'session') s.cardId = card.id;
      if (sub.kind === 'routine') for (const run of routines.get(sub.routineId).runs) run.cardId = card.id;
      for (const pr of s.prs) prs.set(`${pr.repo}#${pr.number}`, pr);
      for (const t of s.tickets) tickets.add(t);
      if (s.lastActivityAt > lastActivityAt) lastActivityAt = s.lastActivityAt;
    }
    return { ...card, view: { subs, counts, prs: [...prs.values()], tickets: [...tickets], lastActivityAt: lastActivityAt || card.updatedAt } };
  });

  // Connections nobody drew but the sessions imply.
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const pairs = new Map();
  const addReason = (a, b, reason) => {
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let p = pairs.get(key);
    if (!p) pairs.set(key, (p = { a: a < b ? a : b, b: a < b ? b : a, reasons: [] }));
    if (!p.reasons.includes(reason) && p.reasons.length < 4) p.reasons.push(reason);
  };
  const prOwners = new Map();
  const ticketOwners = new Map();
  for (const s of sessions) {
    if (!s.cardId) continue;
    const parent = byId.get(s.parentId || s.forkedFrom);
    if (parent && parent.cardId) addReason(s.cardId, parent.cardId, `"${s.title}" was started from "${parent.title}"`);
    for (const pr of s.prs) {
      const k = `${pr.repo}#${pr.number}`;
      if (!prOwners.has(k)) prOwners.set(k, new Set());
      prOwners.get(k).add(s.cardId);
    }
  }
  for (const c of cards) {
    for (const t of c.view.tickets) {
      if (!ticketOwners.has(t)) ticketOwners.set(t, new Set());
      ticketOwners.get(t).add(c.id);
    }
  }
  const fanOut = (owners, label) => {
    for (const [k, set] of owners) {
      const ids = [...set];
      if (ids.length < 2 || ids.length > 6) continue; // shared by everything = not a signal
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addReason(ids[i], ids[j], label(k));
    }
  };
  fanOut(prOwners, (k) => `both touch PR #${k.split('#').pop()}`);
  fanOut(ticketOwners, (k) => `both mention ${k}`);
  const explicit = new Set();
  for (const c of cards) for (const l of c.links) explicit.add(c.id < l.to ? `${c.id}|${l.to}` : `${l.to}|${c.id}`);
  const implicit = [...pairs.entries()]
    .filter(([key, p]) => !explicit.has(key) && cardById.has(p.a) && cardById.has(p.b))
    .map(([, p]) => p);

  // Where an unsorted session probably belongs.
  for (const s of sessions) {
    s.suggest = null;
    if (s.cardId || s.archived) continue;
    if (s.routineId && routineCard.has(s.routineId)) {
      s.cardId = routineCard.get(s.routineId);
      continue;
    }
    for (const pr of s.prs) {
      const owners = prOwners.get(`${pr.repo}#${pr.number}`);
      if (owners && owners.size === 1) {
        s.suggest = { cardId: [...owners][0], reason: `shares PR #${pr.number}` };
        break;
      }
    }
    if (!s.suggest) {
      for (const t of s.tickets) {
        const owners = ticketOwners.get(t);
        if (owners && owners.size === 1) {
          s.suggest = { cardId: [...owners][0], reason: `mentions ${t}` };
          break;
        }
      }
    }
  }

  return {
    generatedAt: Date.now(),
    scannedAt: scanResult.scannedAt,
    columns: board.columns,
    settings: board.settings,
    cards,
    implicit,
    sessions,
    groups: scanResult.groups,
    routines: [...routines.values()].map((r) => ({ id: r.id, title: r.title, runs: r.runs.length, latestId: r.latest.id, cardId: routineCard.get(r.id) || null })),
    paths: { data: P.DATA_DIR, board: P.BOARD_FILE, cards: P.CARDS_DIR },
  };
}

// ---------- automatic linking ----------

/** Which unlinked sessions the cards' rules claim. Returns [{cardId, sessionId, via}]. */
function planAutoLinks(board, sessions) {
  const meta = board.sessionMeta;
  const cardById = new Map(board.cards.map((c) => [c.id, c]));
  const linked = new Map();
  const routineIds = new Set();
  for (const c of board.cards) {
    for (const sub of c.subtasks) {
      if (sub.sessionId) linked.set(sub.sessionId, c.id);
      if (sub.routineId) routineIds.add(sub.routineId);
    }
  }
  const free = (s) => !linked.has(s.id) && !(meta[s.id] && meta[s.id].noAuto) && !(s.routineId && routineIds.has(s.routineId));
  const live = board.cards.filter((c) => !c.archived);
  const adds = [];
  const claim = (s, cardId, via) => {
    adds.push({ cardId, sessionId: s.id, via });
    linked.set(s.id, cardId);
  };
  for (const s of sessions) {
    if (!free(s)) continue;
    const byGroup = s.groupId && live.find((c) => c.auto.groupId === s.groupId);
    if (byGroup) {
      claim(s, byGroup.id, 'group');
      continue;
    }
    const byTicket = s.tickets.length && live.find((c) => (c.auto.ticketKeys || []).some((k) => s.tickets.includes(k)));
    if (byTicket) claim(s, byTicket.id, 'ticket');
  }
  if (board.settings.inheritChildren !== false) {
    for (let changed = true; changed; ) {
      changed = false;
      for (const s of sessions) {
        if (!free(s)) continue;
        const cardId = linked.get(s.parentId) || linked.get(s.forkedFrom);
        const card = cardId && cardById.get(cardId);
        if (card && !card.archived && card.auto.inheritChildren !== false) {
          claim(s, card.id, 'child');
          changed = true;
        }
      }
    }
  }
  return adds;
}

/** Apply the linking rules. Returns how many sessions were linked. */
function applyAutoLinks(scanResult) {
  if (!store.exists()) return 0;
  if (!planAutoLinks(store.load(), scanResult.sessions).length) return 0;
  return store.mutate((b) => {
    const adds = planAutoLinks(b, scanResult.sessions); // again, under the lock
    const byCard = new Map();
    for (const a of adds) {
      if (!byCard.has(a.cardId)) byCard.set(a.cardId, new Map());
      const m = byCard.get(a.cardId);
      if (!m.has(a.via)) m.set(a.via, []);
      m.get(a.via).push(a.sessionId);
    }
    for (const [cardId, vias] of byCard) {
      for (const [via, sessionIds] of vias) store.OPS['session.link'](b, { card: cardId, sessionIds, via });
    }
    return adds.length;
  });
}

// ---------- first run ----------

function inferStatus(b, members) {
  const open = members.filter((s) => !s.archived);
  const has = (id) => b.columns.some((c) => c.id === id);
  const pick = (id) => (has(id) ? id : b.columns[0].id);
  if (!open.length) return pick('done');
  const latest = Math.max(...open.map((s) => s.lastActivityAt));
  if (open.some((s) => s.state === 'running') || Date.now() - latest < 4 * DAY) return pick('in_progress');
  if (open.some((s) => s.state === 'needs_you')) return pick('waiting');
  if (open.some((s) => s.state === 'review')) return pick('review');
  if (open.every((s) => s.state === 'done')) return pick('done');
  return pick('backlog');
}

function mostCommon(values, min) {
  const n = new Map();
  for (const v of values) if (v) n.set(v, (n.get(v) || 0) + 1);
  const top = [...n.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= (min || 1) ? top[0] : '';
}

/**
 * Build a starting board from how the sessions are already organised:
 * sidebar groups, sessions that started each other, and scheduled tasks.
 * Runs only when there is no board file yet.
 */
function seed(scanResult) {
  if (store.exists()) return null;
  const { sessions, groups } = scanResult;
  return store.mutate((b) => {
    if (b.cards.length) return null;
    const made = { groups: 0, families: 0, routines: 0 };
    const taken = new Set();

    // Jira-style links: reuse the site the sessions already point at.
    for (const s of sessions) {
      const m = /https:\/\/([a-z0-9-]+)\.atlassian\.net\/browse\//i.exec(s.title);
      if (m) {
        b.settings.ticketUrl = `https://${m[1]}.atlassian.net/browse/{key}`;
        break;
      }
    }

    const create = (title, members, extra) => {
      const card = store.OPS['card.create'](b, {
        title,
        status: inferStatus(b, members),
        project: mostCommon(members.map((s) => s.projectName)),
        ...extra,
      });
      const ids = members.filter((s) => !s.routineId).sort((x, y) => x.createdAt - y.createdAt).map((s) => s.id);
      if (ids.length) store.OPS['session.link'](b, { card: card.id, sessionIds: ids, via: extra.via });
      for (const id of ids) taken.add(id);
      return card;
    };

    for (const g of groups) {
      const members = sessions.filter((s) => s.groupId === g.id);
      if (!members.length) continue;
      const ticket = mostCommon(members.flatMap((s) => s.tickets), 2);
      const card = create(g.name, members, { via: 'group', ticket, auto: { groupId: g.id, ticketKeys: ticket ? [ticket] : [] } });
      store.OPS['note.add'](b, { card: card.id, by: 'taskboard', text: `Imported from your Claude sidebar group "${g.name}". Sessions you file under that group join this card on their own.` });
      made.groups++;
    }

    // Children of what the groups already hold go with their parent.
    for (const a of planAutoLinks(b, sessions)) {
      store.OPS['session.link'](b, { card: a.cardId, sessionIds: [a.sessionId], via: a.via });
      taken.add(a.sessionId);
    }

    // Sessions that started one another are one piece of work.
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const root = new Map();
    const find = (id) => {
      let r = id;
      while (root.get(r) && root.get(r) !== r) r = root.get(r);
      return r;
    };
    for (const s of sessions) root.set(s.id, s.id);
    for (const s of sessions) {
      const p = s.parentId || s.forkedFrom;
      if (p && byId.has(p)) root.set(find(s.id), find(p));
    }
    const families = new Map();
    for (const s of sessions) {
      const r = find(s.id);
      if (!families.has(r)) families.set(r, []);
      families.get(r).push(s);
    }
    const ordered = [...families.values()]
      .filter((m) => m.length >= 2 && m.some((s) => !s.archived) && !m.some((s) => taken.has(s.id) || s.routineId))
      .sort((x, y) => Math.max(...x.map((s) => s.lastActivityAt)) - Math.max(...y.map((s) => s.lastActivityAt)));
    for (const members of ordered) {
      const top = members.filter((s) => !members.some((m) => m.id === (s.parentId || s.forkedFrom))).sort((x, y) => x.createdAt - y.createdAt)[0] || members[0];
      const card = create(top.title, members, { via: 'family', ticket: mostCommon(members.flatMap((s) => s.tickets), 2) });
      store.OPS['note.add'](b, { card: card.id, by: 'taskboard', text: `Imported: ${members.length} sessions that were started from one another.` });
      made.families++;
    }

    // One card per scheduled task; its runs collapse into a single sub-task.
    const routines = buildRoutines(sessions);
    for (const r of routines.values()) {
      if (!r.runs.some((s) => !s.archived)) continue;
      const waiting = r.latest.state === 'needs_you' && !r.latest.archived;
      const col = b.columns.find((c) => c.id === (waiting ? 'waiting' : 'in_progress')) || b.columns[0];
      const card = store.OPS['card.create'](b, { title: r.title, status: col.id, project: r.latest.projectName, tags: ['routine'] });
      store.OPS['routine.link'](b, { card: card.id, routineId: r.id });
      made.routines++;
    }
    return made;
  });
}

// ---------- Markdown copies for Claude ----------

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function cardMarkdown(card, state) {
  const colName = (id) => (state.columns.find((c) => c.id === id) || { name: id }).name;
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const cardById = new Map(state.cards.map((c) => [c.id, c]));
  const v = card.view;
  const L = [];
  L.push(`# ${card.key} · ${card.title}`, '');
  const head = [`Status: **${colName(card.status)}**`, `Priority: ${card.priority}`];
  if (card.project) head.push(`Project: ${card.project}`);
  if (card.ticket) head.push(`Ticket: ${card.ticket}`);
  if (card.due) head.push(`Due: ${card.due}`);
  if (card.tags.length) head.push(`Tags: ${card.tags.join(', ')}`);
  L.push(head.join(' · '), `Board: ${P.boardUrl('card=' + card.key)}`, `Updated: ${fmtDate(card.updatedAt)}`, '');
  if (card.description.trim()) L.push('## Description', '', card.description.trim(), '');
  L.push(`## Sub-tasks (${v.counts.done}/${v.counts.total} done)`, '');
  if (!v.subs.length) L.push('_None yet._');
  for (const sub of v.subs) {
    const box = sub.status === 'done' ? '[x]' : '[ ]';
    let line = `- ${box} ${sub.title} — ${SUB_LABEL[sub.status] || sub.status}`;
    const s = sub.sessionId && byId.get(sub.sessionId);
    if (sub.kind === 'routine') line += ` (scheduled task, ${sub.runs || 0} runs; latest run below)`;
    if (s) {
      line += `\n  - Claude session \`${s.id}\`: ${STATE_LABEL[s.estate] || s.estate}, last active ${fmtDate(s.lastActivityAt)}${s.projectName ? `, in ${s.projectName}` : ''}`;
      if (s.estate === 'needs_you' && s.summary && s.summary.needsAction) line += `\n  - Waiting on the user: ${s.summary.needsAction}`;
      else if (s.summary && s.summary.detail) line += `\n  - Latest: ${s.summary.detail}`;
      if (s.steps) line += `\n  - Steps: ${s.steps.done}/${s.steps.total}${s.steps.current ? `, now on "${s.steps.current}"` : ''}`;
      if (s.prs.length) line += `\n  - PRs: ${s.prs.map((p) => `${p.repo}#${p.number}${p.state ? ` (${p.state.toLowerCase()})` : ''}`).join(', ')}`;
      if (s.wrapUp) line += `\n  - Outcome: ${s.wrapUp}`;
    }
    L.push(line);
  }
  L.push('');
  const conns = [];
  for (const l of card.links) {
    const o = cardById.get(l.to);
    if (o) conns.push(`- ${l.type === 'blocks' ? 'blocks' : l.type === 'parent' ? 'parent of' : 'related to'} ${o.key} · ${o.title} (${colName(o.status)})`);
  }
  for (const o of state.cards) {
    for (const l of o.links) {
      if (l.to === card.id) conns.push(`- ${l.type === 'blocks' ? 'blocked by' : l.type === 'parent' ? 'part of' : 'related to'} ${o.key} · ${o.title} (${colName(o.status)})`);
    }
  }
  for (const p of state.implicit) {
    if (p.a !== card.id && p.b !== card.id) continue;
    const o = cardById.get(p.a === card.id ? p.b : p.a);
    if (o) conns.push(`- possibly related to ${o.key} · ${o.title}: ${p.reasons.join('; ')}`);
  }
  if (conns.length) L.push('## Connections', '', ...conns, '');
  if (card.notes.length) {
    L.push('## Notes', '');
    for (const n of card.notes.slice(-30)) L.push(`- ${fmtDate(n.at)} (${n.by}): ${n.text.replace(/\n+/g, ' ')}`);
    L.push('');
  }
  L.push('---', 'Generated by Taskboard; edits to this file are overwritten. Change the card in the board, with the `taskboard` command, or with the `board_*` tools.', '');
  return L.join('\n');
}

function overviewMarkdown(state) {
  const L = ['# Taskboard', '', `Board: ${P.boardUrl()} · updated ${fmtDate(state.generatedAt)}`, ''];
  for (const col of state.columns) {
    const cards = state.cards.filter((c) => c.status === col.id && !c.archived).sort((a, b) => a.order - b.order);
    L.push(`## ${col.name} (${cards.length})`, '');
    for (const c of cards) {
      const v = c.view;
      const bits = [`${v.counts.done}/${v.counts.total} sub-tasks`];
      if (v.counts.running) bits.push(`${v.counts.running} running`);
      if (v.counts.needs) bits.push(`${v.counts.needs} waiting on the user`);
      L.push(`- **${c.key}** ${c.title}${c.ticket ? ` [${c.ticket}]` : ''} — ${bits.join(', ')} — \`cards/${c.key}.md\``);
    }
    if (!cards.length) L.push('_Empty._');
    L.push('');
  }
  return L.join('\n');
}

/** The opening prompt for a new Claude session that is going to work on a card. */
function sessionBrief(card) {
  return `Work on Taskboard card ${card.key} "${card.title}".\n\nFirst read the card with board_get_card (card: "${card.key}"), or the file ~/.claude/taskboard/cards/${card.key}.md, and link this session to it with board_link_session. Then: `;
}

function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false;
  } catch (_) {}
  fs.writeFileSync(file, text);
  return true;
}

/** Keep one Markdown file per card (and an overview) in step with the board. */
function exportMarkdown(state) {
  try {
    fs.mkdirSync(P.CARDS_DIR, { recursive: true });
    const keep = new Set();
    for (const card of state.cards) {
      const name = `${card.key}.md`;
      keep.add(name);
      writeIfChanged(path.join(P.CARDS_DIR, name), cardMarkdown(card, state));
    }
    for (const f of fs.readdirSync(P.CARDS_DIR)) {
      if (f.endsWith('.md') && !keep.has(f)) fs.unlinkSync(path.join(P.CARDS_DIR, f));
    }
    writeIfChanged(P.OVERVIEW_FILE, overviewMarkdown(state));
  } catch (_) {}
}

module.exports = {
  buildState, planAutoLinks, applyAutoLinks, seed, exportMarkdown, cardMarkdown, overviewMarkdown, sessionBrief,
  effectiveState, ackToken, inferStatus, SUB_LABEL, STATE_LABEL, fmtDate,
};
