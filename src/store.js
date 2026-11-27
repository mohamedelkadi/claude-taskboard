'use strict';
// The board itself: one JSON file, changed only through the named operations
// below. The web server, the MCP server (one per Claude session) and the CLI
// all go through `apply`, which takes a file lock, so they can write at the
// same time without losing each other's changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');

const SUB_STATUSES = ['todo', 'in_progress', 'blocked', 'review', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const LINK_TYPES = ['blocks', 'relates', 'parent'];

const DEFAULT_COLUMNS = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'todo', name: 'To do' },
  { id: 'in_progress', name: 'In progress' },
  { id: 'waiting', name: 'Waiting on me' },
  { id: 'review', name: 'In review' },
  { id: 'done', name: 'Done', done: true },
];

const DEFAULT_SETTINGS = {
  keyPrefix: 'TB',
  ticketUrl: '', // e.g. https://acme.atlassian.net/browse/{key}
  inheritChildren: true, // a session started from a linked session joins the same card
  autostart: true, // Claude sessions start the board server when it is not running
  followSessions: true, // a card that has not started moves to In progress when one of its sessions works
};

class UserError extends Error {}

const now = () => Date.now();
const rid = () => crypto.randomBytes(4).toString('hex');
const str = (v, max) => (v == null ? '' : String(v).slice(0, max));
const clean = (v, max) => str(v, max).replace(/\s+/g, ' ').trim();
const isLink = (v) => /^https?:\/\//i.test(String(v || ''));
/** A ticket is a tracker key (PROJ-12, upper-cased) or a link to it, which is kept exactly as typed. */
const ticketValue = (v) => (isLink(str(v, 500).trim()) ? str(v, 500).trim().replace(/\s+/g, '') : clean(v, 60).toUpperCase());

function emptyBoard() {
  const t = now();
  return {
    version: 1,
    seq: 0,
    columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
    cards: [],
    sessionMeta: {},
    dayNotes: {}, // the diary's own notes, by day (YYYY-MM-DD)
    settings: { ...DEFAULT_SETTINGS },
    createdAt: t,
    updatedAt: t,
  };
}

function normalize(b) {
  if (!b || typeof b !== 'object') return emptyBoard();
  if (!Array.isArray(b.columns) || !b.columns.length) b.columns = DEFAULT_COLUMNS.map((c) => ({ ...c }));
  if (!Array.isArray(b.cards)) b.cards = [];
  if (!b.sessionMeta || typeof b.sessionMeta !== 'object') b.sessionMeta = {};
  if (!b.dayNotes || typeof b.dayNotes !== 'object' || Array.isArray(b.dayNotes)) b.dayNotes = {};
  b.settings = { ...DEFAULT_SETTINGS, ...(b.settings || {}) };
  if (typeof b.seq !== 'number') b.seq = b.cards.length;
  const colIds = new Set(b.columns.map((c) => c.id));
  for (const c of b.cards) {
    if (!colIds.has(c.status)) c.status = b.columns[0].id;
    if (!Array.isArray(c.subtasks)) c.subtasks = [];
    if (!Array.isArray(c.links)) c.links = [];
    if (!Array.isArray(c.notes)) c.notes = [];
    if (!Array.isArray(c.attachments)) c.attachments = [];
    if (!Array.isArray(c.tags)) c.tags = [];
    if (!Array.isArray(c.workflows)) c.workflows = [];
    if (!Array.isArray(c.runs)) c.runs = [];
    if (!c.auto || typeof c.auto !== 'object') c.auto = {};
    if (typeof c.order !== 'number') c.order = 0;
    // when the card was put in its column: sessions that work after that can move it on
    if (typeof c.statusAt !== 'number') c.statusAt = b.updatedAt || c.updatedAt || 0;
    // an earlier version upper-cased links typed as the ticket, and took them for ticket keys
    if (/^HTTPS?:\/\//.test(c.ticket || '')) {
      const typed = (String(c.description || '').match(/https?:\/\/[^\s)>\]]+/gi) || []).find((u) => u.toUpperCase().startsWith(c.ticket));
      c.ticket = typed || c.ticket.replace(/^[^/]+\/\/[^/]+/, (origin) => origin.toLowerCase());
    }
    if (Array.isArray(c.auto.ticketKeys) && c.auto.ticketKeys.some(isLink)) c.auto.ticketKeys = c.auto.ticketKeys.filter((k) => !isLink(k));
  }
  return b;
}

// ---------- file access ----------

function exists() {
  return fs.existsSync(P.BOARD_FILE);
}

function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(P.BOARD_FILE, 'utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return emptyBoard();
    // A corrupt board must never be silently replaced by an empty one.
    throw new Error(`Cannot read ${P.BOARD_FILE}: ${e.message}. Restore a copy from ${P.BACKUP_DIR}.`);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(fn) {
  fs.mkdirSync(P.DATA_DIR, { recursive: true });
  const lock = P.BOARD_FILE + '.lock';
  const started = now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        // A holder that died leaves its lock behind; nothing holds it this long.
        if (now() - fs.statSync(lock).mtimeMs > 5000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch (_) {
        continue; // released between the open and the stat
      }
      if (now() - started > 8000) throw new Error('The board file is locked by another process.');
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch (_) {}
  }
}

function backup() {
  // One copy per hour of use, newest 48 kept.
  try {
    if (!fs.existsSync(P.BOARD_FILE)) return;
    fs.mkdirSync(P.BACKUP_DIR, { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}`;
    const target = path.join(P.BACKUP_DIR, `board-${stamp}.json`);
    if (fs.existsSync(target)) return;
    fs.copyFileSync(P.BOARD_FILE, target);
    const old = fs.readdirSync(P.BACKUP_DIR).filter((f) => /^board-\d{8}-\d{2}\.json$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 48))) fs.unlinkSync(path.join(P.BACKUP_DIR, f));
  } catch (_) {}
}

function save(b) {
  fs.mkdirSync(P.DATA_DIR, { recursive: true });
  backup();
  const tmp = `${P.BOARD_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b, null, 1));
  fs.renameSync(tmp, P.BOARD_FILE);
}

/** Read, change and write the board under the lock. `fn` may return a value. */
function mutate(fn) {
  return withLock(() => {
    const b = load();
    const result = fn(b);
    b.updatedAt = now();
    save(b);
    return result;
  });
}

// ---------- lookups ----------

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const STATUS_ALIASES = {
  todo: 'todo', new: 'todo', open: 'todo',
  doing: 'in_progress', inprogress: 'in_progress', wip: 'in_progress', started: 'in_progress', active: 'in_progress',
  blocked: 'waiting', waiting: 'waiting', waitingonme: 'waiting', needsme: 'waiting',
  review: 'review', inreview: 'review',
  done: 'done', complete: 'done', completed: 'done', closed: 'done', finished: 'done',
  backlog: 'backlog', later: 'backlog',
};

function findColumn(b, ref) {
  const n = norm(ref);
  const col =
    b.columns.find((c) => c.id === ref) ||
    b.columns.find((c) => norm(c.name) === n || norm(c.id) === n) ||
    b.columns.find((c) => c.id === STATUS_ALIASES[n]);
  if (!col) {
    throw new UserError(`No column "${ref}". Columns: ${b.columns.map((c) => c.name).join(', ')}.`);
  }
  return col;
}

function findCard(b, ref) {
  const r = String(ref == null ? '' : ref).trim();
  if (!r) throw new UserError('Which card? Give its key (like TB-3) or title.');
  const low = r.toLowerCase();
  const direct = b.cards.find((c) => c.id === r) || b.cards.find((c) => c.key.toLowerCase() === low);
  if (direct) return direct;
  const exact = b.cards.filter((c) => c.title.toLowerCase() === low);
  if (exact.length === 1) return exact[0];
  const some = b.cards.filter((c) => !c.archived && c.title.toLowerCase().includes(low));
  if (some.length === 1) return some[0];
  if (some.length > 1) {
    throw new UserError(
      `"${r}" matches ${some.length} cards (${some.slice(0, 6).map((c) => `${c.key} ${c.title}`).join('; ')}). Use the key.`
    );
  }
  throw new UserError(`No card matches "${r}".`);
}

function findSubtask(card, ref) {
  const r = String(ref == null ? '' : ref).trim();
  const low = r.toLowerCase();
  const hit =
    card.subtasks.find((s) => s.id === r) ||
    card.subtasks.find((s) => s.sessionId && s.sessionId === r) ||
    card.subtasks.find((s) => (s.title || '').toLowerCase() === low);
  if (hit) return hit;
  const some = card.subtasks.filter((s) => (s.title || '').toLowerCase().includes(low));
  if (r && some.length === 1) return some[0];
  throw new UserError(`No sub-task "${r}" on ${card.key}.`);
}

function cardOfSession(b, sessionId) {
  for (const c of b.cards) if (c.subtasks.some((s) => s.sessionId === sessionId)) return c;
  return null;
}

function touch(card) {
  card.updatedAt = now();
}

function topOrder(b, colId) {
  const inCol = b.cards.filter((c) => c.status === colId);
  return inCol.length ? Math.min(...inCol.map((c) => c.order)) - 1000 : 1000;
}

function tagList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(arr.map((t) => clean(t, 30)).filter(Boolean))].slice(0, 12);
}

function sanitizeAuto(a) {
  const out = {};
  if (!a || typeof a !== 'object') return out;
  if (a.groupId) out.groupId = str(a.groupId, 80);
  if (Array.isArray(a.ticketKeys)) out.ticketKeys = [...new Set(a.ticketKeys.filter((k) => !isLink(k)).map((k) => clean(k, 30).toUpperCase()).filter(Boolean))];
  if (Array.isArray(a.routineIds)) out.routineIds = [...new Set(a.routineIds.map((k) => clean(k, 120)).filter(Boolean))];
  if (a.inheritChildren === false) out.inheritChildren = false;
  return out;
}

// ---------- operations ----------

const OPS = {
  'card.create'(b, a) {
    const title = clean(a.title, 200);
    if (!title) throw new UserError('A card needs a title.');
    const col = a.status ? findColumn(b, a.status) : b.columns.find((c) => c.id === 'todo') || b.columns[0];
    b.seq += 1;
    const t = now();
    const card = {
      id: 'c_' + rid(),
      key: `${b.settings.keyPrefix || 'TB'}-${b.seq}`,
      title,
      description: str(a.description, 20000),
      status: col.id,
      order: topOrder(b, col.id),
      priority: PRIORITIES.includes(a.priority) ? a.priority : 'medium',
      project: clean(a.project, 200),
      ticket: ticketValue(a.ticket),
      tags: tagList(a.tags),
      due: a.due ? str(a.due, 10) : null,
      subtasks: [],
      links: [],
      notes: [],
      attachments: [],
      workflows: [],
      runs: [],
      auto: sanitizeAuto(a.auto),
      archived: false,
      statusAt: t,
      createdAt: t,
      updatedAt: t,
    };
    b.cards.push(card);
    for (const st of Array.isArray(a.subtasks) ? a.subtasks : []) {
      const stTitle = clean(typeof st === 'string' ? st : st && st.title, 300);
      if (stTitle) card.subtasks.push({ id: 's_' + rid(), title: stTitle, status: 'todo', createdAt: t });
    }
    if (Array.isArray(a.sessionIds) && a.sessionIds.length) {
      OPS['session.link'](b, { card: card.id, sessionIds: a.sessionIds, via: a.via || 'manual' });
    }
    return card;
  },

  'card.update'(b, a) {
    const card = findCard(b, a.card);
    if (a.title !== undefined) {
      const t = clean(a.title, 200);
      if (!t) throw new UserError('A card needs a title.');
      card.title = t;
    }
    if (a.description !== undefined) card.description = str(a.description, 20000);
    if (a.priority !== undefined) {
      if (!PRIORITIES.includes(a.priority)) throw new UserError(`Priority is one of: ${PRIORITIES.join(', ')}.`);
      card.priority = a.priority;
    }
    if (a.project !== undefined) card.project = clean(a.project, 200);
    if (a.ticket !== undefined) card.ticket = ticketValue(a.ticket);
    if (a.tags !== undefined) card.tags = tagList(a.tags);
    if (a.due !== undefined) card.due = a.due ? str(a.due, 10) : null;
    if (a.archived !== undefined) card.archived = !!a.archived;
    if (a.auto !== undefined) card.auto = sanitizeAuto({ ...card.auto, ...a.auto });
    if (a.status !== undefined) {
      const col = findColumn(b, a.status);
      if (col.id !== card.status) {
        card.order = topOrder(b, col.id);
        card.status = col.id;
        card.statusAt = now();
      }
    }
    touch(card);
    return card;
  },

  // Drop a card into a column, before `beforeId` (or at the end when omitted).
  'card.move'(b, a) {
    const card = findCard(b, a.card);
    const col = findColumn(b, a.status || card.status);
    const others = b.cards.filter((c) => c.status === col.id && c.id !== card.id).sort((x, y) => x.order - y.order);
    let at = others.length;
    if (a.beforeId) {
      const i = others.findIndex((c) => c.id === a.beforeId);
      if (i >= 0) at = i;
    } else if (a.top) at = 0;
    others.splice(at, 0, card);
    if (card.status !== col.id) card.statusAt = now();
    card.status = col.id;
    others.forEach((c, i) => (c.order = (i + 1) * 1000));
    touch(card);
    return card;
  },

  'card.delete'(b, a) {
    const card = findCard(b, a.card);
    b.cards = b.cards.filter((c) => c.id !== card.id);
    for (const c of b.cards) c.links = c.links.filter((l) => l.to !== card.id);
    return { deleted: card.key };
  },

  'subtask.add'(b, a) {
    const card = findCard(b, a.card);
    const title = clean(a.title, 300);
    if (!title) throw new UserError('A sub-task needs a title.');
    const status = a.status && SUB_STATUSES.includes(a.status) ? a.status : 'todo';
    const sub = { id: 's_' + rid(), title, status, createdAt: now() };
    card.subtasks.push(sub);
    touch(card);
    return sub;
  },

  'subtask.update'(b, a) {
    const card = findCard(b, a.card);
    const sub = findSubtask(card, a.subtask);
    if (a.title !== undefined) sub.title = clean(a.title, 300);
    if (a.status !== undefined) {
      const linked = sub.sessionId || sub.routineId;
      const allowed = linked ? [...SUB_STATUSES, 'auto'] : SUB_STATUSES;
      if (!allowed.includes(a.status)) throw new UserError(`Sub-task status is one of: ${allowed.join(', ')}.`);
      sub.status = a.status;
    }
    touch(card);
    return sub;
  },

  'subtask.remove'(b, a) {
    const card = findCard(b, a.card);
    const sub = findSubtask(card, a.subtask);
    card.subtasks = card.subtasks.filter((s) => s.id !== sub.id);
    // sessions started from a checklist item stay on the card, on their own
    for (const s of card.subtasks) if (s.forSub === sub.id) delete s.forSub;
    // Removing a linked session by hand means "not this card": do not auto-link it again.
    if (sub.sessionId) b.sessionMeta[sub.sessionId] = { ...(b.sessionMeta[sub.sessionId] || {}), noAuto: true };
    if (sub.routineId && card.auto.routineIds) {
      card.auto.routineIds = card.auto.routineIds.filter((r) => r !== sub.routineId);
    }
    touch(card);
    return { removed: sub.id };
  },

  'subtask.reorder'(b, a) {
    const card = findCard(b, a.card);
    const ids = Array.isArray(a.ids) ? a.ids : [];
    const byId = new Map(card.subtasks.map((s) => [s.id, s]));
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const s of card.subtasks) if (!next.includes(s)) next.push(s);
    card.subtasks = next;
    touch(card);
    return card;
  },

  // A linked session is a sub-task whose status follows the session.
  'session.link'(b, a) {
    const card = findCard(b, a.card);
    const ids = [...new Set((Array.isArray(a.sessionIds) ? a.sessionIds : [a.sessionId]).filter(Boolean).map(String))];
    if (!ids.length) throw new UserError('Which session?');
    // `subtask`: the checklist item the session works on; it is shown under that item
    const parent = a.subtask ? findSubtask(card, a.subtask) : null;
    if (parent && (parent.sessionId || parent.routineId)) throw new UserError('A session can only go under a checklist item, not under another session.');
    const t = now();
    for (const sid of ids) {
      for (const c of b.cards) {
        if (c.id === card.id) continue;
        const before = c.subtasks.length;
        c.subtasks = c.subtasks.filter((s) => s.sessionId !== sid);
        if (c.subtasks.length !== before) touch(c);
      }
      let row = card.subtasks.find((s) => s.sessionId === sid);
      if (!row) card.subtasks.push((row = { id: 's_' + rid(), title: '', status: 'auto', sessionId: sid, via: a.via || 'manual', createdAt: t }));
      if (parent) {
        row.forSub = parent.id;
        if (parent.status === 'todo') parent.status = 'in_progress'; // a session is working on it now
      }
      const meta = b.sessionMeta[sid];
      if (meta) {
        delete meta.noAuto;
        delete meta.hidden;
        if (!Object.keys(meta).length) delete b.sessionMeta[sid];
      }
    }
    touch(card);
    return card;
  },

  'session.unlink'(b, a) {
    const ids = new Set((Array.isArray(a.sessionIds) ? a.sessionIds : [a.sessionId]).filter(Boolean).map(String));
    let n = 0;
    for (const c of b.cards) {
      const before = c.subtasks.length;
      c.subtasks = c.subtasks.filter((s) => !ids.has(s.sessionId));
      if (c.subtasks.length !== before) {
        n += before - c.subtasks.length;
        touch(c);
      }
    }
    for (const sid of ids) b.sessionMeta[sid] = { ...(b.sessionMeta[sid] || {}), noAuto: true };
    return { unlinked: n };
  },

  // hidden: keep it out of the unsorted list.
  // ack: "I have dealt with what it asked". It is a map of session id to a
  // token naming the request that was dealt with, so a later request from the
  // same session shows up again.
  'session.meta'(b, a) {
    const ids = (Array.isArray(a.sessionIds) ? a.sessionIds : [a.sessionId]).filter(Boolean).map(String);
    for (const sid of ids) {
      const m = { ...(b.sessionMeta[sid] || {}) };
      if (a.hidden !== undefined) a.hidden ? (m.hidden = true) : delete m.hidden;
      if (a.ack !== undefined) {
        const token = a.ack && typeof a.ack === 'object' ? a.ack[sid] : a.ack;
        token ? (m.ack = String(token)) : delete m.ack;
      }
      if (Object.keys(m).length) b.sessionMeta[sid] = m;
      else delete b.sessionMeta[sid];
    }
    return { updated: ids.length };
  },

  // All runs of a scheduled task show as one sub-task that follows the latest run.
  'routine.link'(b, a) {
    const card = findCard(b, a.card);
    const routineId = clean(a.routineId, 120);
    if (!routineId) throw new UserError('Which routine?');
    for (const c of b.cards) {
      if (c.id === card.id) continue;
      c.subtasks = c.subtasks.filter((s) => s.routineId !== routineId);
      if (c.auto.routineIds) c.auto.routineIds = c.auto.routineIds.filter((r) => r !== routineId);
    }
    if (!card.subtasks.some((s) => s.routineId === routineId)) {
      card.subtasks.push({ id: 's_' + rid(), title: '', status: 'auto', routineId, via: 'manual', createdAt: now() });
    }
    card.auto.routineIds = [...new Set([...(card.auto.routineIds || []), routineId])];
    touch(card);
    return card;
  },

  'link.add'(b, a) {
    const from = findCard(b, a.from);
    const to = findCard(b, a.to);
    const type = a.type || 'relates';
    if (!LINK_TYPES.includes(type)) throw new UserError(`Connection type is one of: ${LINK_TYPES.join(', ')}.`);
    if (from.id === to.id) throw new UserError('A card cannot be connected to itself.');
    // one connection per pair, whichever way round it was first made
    from.links = from.links.filter((l) => l.to !== to.id);
    to.links = to.links.filter((l) => l.to !== from.id);
    from.links.push({ type, to: to.id, createdAt: now() });
    touch(from);
    touch(to);
    return { from: from.key, to: to.key, type };
  },

  'link.remove'(b, a) {
    const from = findCard(b, a.from);
    const to = findCard(b, a.to);
    from.links = from.links.filter((l) => l.to !== to.id);
    to.links = to.links.filter((l) => l.to !== from.id);
    touch(from);
    touch(to);
    return { removed: true };
  },

  'note.add'(b, a) {
    const card = findCard(b, a.card);
    const text = str(a.text, 4000).trim();
    if (!text) throw new UserError('The note is empty.');
    const note = { id: 'n_' + rid(), text, at: now(), by: clean(a.by, 120) || 'me' };
    card.notes.push(note);
    if (card.notes.length > 200) card.notes = card.notes.slice(-200);
    touch(card);
    return note;
  },

  'note.remove'(b, a) {
    const card = findCard(b, a.card);
    card.notes = card.notes.filter((n) => n.id !== a.noteId);
    touch(card);
    return { removed: true };
  },

  // Adding one goes through addAttachment, with a file already on disk.
  'attachment.remove'(b, a) {
    const card = findCard(b, a.card);
    card.attachments = card.attachments.filter((f) => f.id !== a.attachment);
    touch(card);
    return { removed: true };
  },

  // The diary's note for one day; an empty text removes it.
  'diary.note'(b, a) {
    const day = str(a.day, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UserError('Which day? Give it as YYYY-MM-DD.');
    let text = str(a.text, 8000).trim();
    const had = b.dayNotes[day] && b.dayNotes[day].text;
    if (a.append) {
      if (!text) throw new UserError('The note is empty.');
      if (had) text = `${had}\n${text}`.slice(0, 8000);
    }
    if (text) b.dayNotes[day] = { text, at: now() };
    else delete b.dayNotes[day];
    return { day, text };
  },

  'columns.set'(b, a) {
    const input = Array.isArray(a.columns) ? a.columns : [];
    const seen = new Set();
    const cols = [];
    for (const c of input) {
      const name = clean(c && c.name, 40);
      if (!name) continue;
      let id = c.id && /^[a-z0-9_]+$/.test(c.id) ? c.id : norm(name).slice(0, 24) || 'col';
      while (seen.has(id)) id += '_' + rid().slice(0, 3);
      seen.add(id);
      cols.push(c.done ? { id, name, done: true } : { id, name });
    }
    if (!cols.length) throw new UserError('The board needs at least one column.');
    for (const card of b.cards) {
      if (!seen.has(card.status)) {
        // its column was deleted: keep the card, park it in the first column
        card.status = cols[0].id;
        card.order = topOrder({ cards: b.cards.filter((c) => c !== card) }, cols[0].id);
      }
    }
    b.columns = cols;
    return cols;
  },

  'settings.update'(b, a) {
    const s = b.settings;
    if (a.keyPrefix !== undefined) s.keyPrefix = clean(a.keyPrefix, 6).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'TB';
    if (a.ticketUrl !== undefined) {
      const u = clean(a.ticketUrl, 300);
      if (u && !/^https?:\/\//.test(u)) throw new UserError('The ticket link must start with http:// or https://.');
      s.ticketUrl = u;
    }
    if (a.inheritChildren !== undefined) s.inheritChildren = !!a.inheritChildren;
    if (a.autostart !== undefined) s.autostart = !!a.autostart;
    if (a.followSessions !== undefined) s.followSessions = !!a.followSessions;
    return s;
  },
};

/** Run one named operation against the board on disk. */
function apply(name, args) {
  const op = OPS[name];
  if (!op) throw new UserError(`Unknown operation "${name}".`);
  let dropped = [];
  const result = mutate((b) => {
    const before = b.cards.flatMap((c) => c.attachments);
    const out = op(b, args || {});
    const kept = new Set(b.cards.flatMap((c) => c.attachments).map((f) => f.id));
    dropped = before.filter((f) => !kept.has(f.id));
    return out;
  });
  // only once the board no longer points at them
  for (const f of dropped) {
    try {
      fs.rmSync(attachmentFile(f), { force: true });
    } catch (_) {}
  }
  return result;
}

const MAX_ATTACHMENTS = 100;

/** Where an attachment's bytes are. */
const attachmentFile = (att) => path.join(P.ATTACH_DIR, path.basename(`${att.id}${att.ext || ''}`));

/** Put a file that is already on disk on a card. Not an operation: a request cannot name a file. */
function addAttachment(cardRef, att) {
  return mutate((b) => {
    const card = findCard(b, cardRef);
    if (card.attachments.length >= MAX_ATTACHMENTS) throw new UserError(`A card can hold ${MAX_ATTACHMENTS} attachments.`);
    card.attachments.push(att);
    touch(card);
    return att;
  });
}

module.exports = {
  SUB_STATUSES, PRIORITIES, LINK_TYPES, DEFAULT_COLUMNS, DEFAULT_SETTINGS,
  UserError, OPS, apply, mutate, load, save, exists, emptyBoard, normalize,
  findCard, findColumn, findSubtask, cardOfSession, attachmentFile, addAttachment,
};

// workflows add their own operations (workflow.save, …); loaded last, as it uses the above
require('./workflows');
