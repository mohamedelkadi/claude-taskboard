'use strict';
// Search inside the conversations themselves, for the session you remember but cannot name.
//
// A full-text index (SQLite FTS5, built into Node) of what was said in each main transcript:
// your prompts, Claude's replies, and the commands and file paths it used. Tool output and
// subagent transcripts are left out. Everything stays on this machine.
//
//   cache/search/index.db   safe to delete; it is rebuilt from the transcripts
//
// Likely secrets are removed before anything is written, and a session's text leaves the
// index when Claude deletes its transcript. The web server keeps the index current from a
// worker thread; the page, the MCP tools and the CLI only read it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const P = require('./paths');
const claude = require('./claude');

const SCHEMA = 1;
const DIR = path.join(P.CACHE_DIR, 'search');
const DB_FILE = path.join(DIR, 'index.db');

const MAX_LINE = 8e6; // a longer record is a pasted image or a dump, not conversation
const MAX_TEXT = 5e5;
const MAX_TOOL = 400;
const CHUNK = 1800;
const OVERLAP = 200;
const CHUNK_LIMIT = 400; // the best passages looked at for one search
const TITLE_WEIGHT = 4;
const FIX_WEIGHT = 0.7; // a passage found only through a corrected spelling counts for less
const UPDATE_GAP = 10000; // a session writing all the time costs one pass every ten seconds

// ---------- SQLite ----------

let sqlite;
/** Node's built-in SQLite, or null on a Node without it (before 22.13). */
function driver() {
  if (sqlite !== undefined) return sqlite;
  const warn = process.emitWarning;
  process.emitWarning = () => {}; // it is marked experimental; that is not the user's concern
  try {
    sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec('create virtual table t using fts5(x)');
    db.close();
  } catch (_) {
    sqlite = null;
  } finally {
    process.emitWarning = warn;
  }
  return sqlite;
}

const available = () => !!driver();

function createSchema(db) {
  db.exec(`
    create table meta(name text primary key, value) without rowid;
    insert into meta values('rev', 0);
    create table transcripts(
      id integer primary key, key text not null unique, size integer not null default 0,
      mtime real not null default 0, offset integer not null default 0, title text not null default '',
      custom integer not null default 0, cwd text not null default '',
      first_at integer not null default 0, last_at integer not null default 0
    );
    create table seen(transcript integer not null, hash blob not null, primary key(transcript, hash)) without rowid;
    create table words(word text not null, transcript integer not null, primary key(word, transcript)) without rowid;
    create index words_by_transcript on words(transcript);
    create virtual table chunks using fts5(
      text, title, transcript unindexed, kind unindexed, at unindexed,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
    insert into chunks(chunks, rank) values('secure-delete', 1);
  `);
  db.exec(`pragma user_version = ${SCHEMA}`);
}

function removeFiles() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + suffix, { force: true });
}

function connect() {
  const { DatabaseSync } = driver();
  let db = new DatabaseSync(DB_FILE);
  try {
    let version = db.prepare('pragma user_version').get().user_version;
    if (version !== SCHEMA && version !== 0) {
      db.close();
      removeFiles();
      db = new DatabaseSync(DB_FILE);
      version = 0;
    }
    db.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000; pragma secure_delete = on;');
    if (version !== SCHEMA) createSchema(db);
    return db;
  } catch (e) {
    try {
      db.close();
    } catch (_) {}
    throw e;
  }
}

function openWrite() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DIR, 0o700); // this holds conversation text
  try {
    return connect();
  } catch (e) {
    if (!/not a database|malformed/i.test(e.message)) throw e;
    removeFiles(); // a damaged index is only a cache: start it again from the transcripts
    return connect();
  }
}

function openRead() {
  if (!available() || !fs.existsSync(DB_FILE)) return null;
  let db = null;
  try {
    db = new (driver().DatabaseSync)(DB_FILE, { readOnly: true });
    db.exec('pragma busy_timeout = 2000');
    if (db.prepare('pragma user_version').get().user_version === SCHEMA) return db;
  } catch (_) {}
  try {
    if (db) db.close();
  } catch (_) {}
  return null;
}

// ---------- what goes in ----------

const KEY_NAMES = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key';
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]'],
  [/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|A(?:KIA|SIA)[0-9A-Z]{16}|xox[abeoprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[redacted]'],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[redacted]'],
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,100}:)[^\s@/]{1,200}@/gi, '$1[redacted]@'],
  [new RegExp(`(?<![\\w-])([\\w-]{0,40}(?:${KEY_NAMES})[\\w-]{0,40}["']?\\s{0,3}[:=]\\s{0,3}["']?)[^\\s"'\`,;&)}\\]]{8,}`, 'gi'), '$1[redacted]'],
];

/** The text with anything that looks like a credential taken out. */
function redact(text) {
  let t = String(text || '');
  for (const [re, to] of SECRETS) t = t.replace(re, to);
  return t;
}

function promptOf(raw) {
  const t = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const text = /<command-name>/.test(t) ? claude.cleanPrompt(t) : t.replace(/<(local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, ' ').trim();
  return !text || /^(Caveat:|\[Request interrupted)/.test(text) ? '' : text;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
}

function addText(job, kind, text, at) {
  const clean = redact(text).trim();
  if (!clean) return;
  job.rows.push({ kind, text: clean.slice(0, kind === 'tool' ? MAX_TOOL : MAX_TEXT), at });
}

function userRecord(job, o, content, at) {
  if (o.isMeta || o.isCompactSummary || o.toolUseResult) return;
  if (o.origin && o.origin.kind && o.origin.kind !== 'human') return;
  addText(job, 'prompt', promptOf(textOf(content)), at);
}

function handleLine(buf, job) {
  if (buf.length < 40 || buf.length > MAX_LINE) return;
  if (buf.subarray(0, 64).includes('"type":"api-request')) return;
  // tool output is most of a transcript, and is not indexed
  if (buf.includes('"type":"tool_result"') && !buf.includes('"type":"assistant"')) return;
  let o;
  try {
    o = JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return; // a half-written line
  }
  if (!o) return;
  if (o.type === 'custom-title' && o.customTitle) {
    job.title = redact(claude.trimText(o.customTitle, 160));
    job.custom = 1;
    return;
  }
  if (o.type === 'ai-title' && o.aiTitle) {
    if (!job.custom) job.title = redact(claude.trimText(o.aiTitle, 160));
    return;
  }
  if (o.isSidechain) return;
  const at = Date.parse(o.timestamp) || 0;
  if (o.type === 'attachment') {
    const a = o.attachment || {};
    const origin = a.origin || o.origin;
    if (a.type === 'queued_command' && a.commandMode === 'prompt' && !(origin && origin.kind && origin.kind !== 'human')) {
      addText(job, 'prompt', promptOf(textOf(a.prompt)), at || job.last);
    }
    return;
  }
  if (o.type !== 'user' && o.type !== 'assistant') return;
  if (at) {
    job.first = job.first || at;
    job.last = at;
  }
  if (o.cwd && !job.cwd) job.cwd = String(o.cwd);
  const content = o.message && o.message.content;
  if (o.type === 'user') return userRecord(job, o, content, at);
  if (!Array.isArray(content) || o.isApiErrorMessage) return;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') addText(job, 'answer', b.text, at);
    else if (b.type === 'tool_use' && b.input) {
      const v = b.input.command || b.input.file_path || b.input.notebook_path || b.input.pattern;
      if (typeof v === 'string') addText(job, 'tool', v, at);
    }
  }
}

function* pieces(text) {
  if (text.length <= CHUNK) {
    yield text;
    return;
  }
  for (let i = 0; i < text.length; i += CHUNK - OVERLAP) {
    yield text.slice(i, i + CHUNK);
    if (i + CHUNK >= text.length) break;
  }
}

const WORD = /(?<![\p{L}\p{N}_])\p{L}{4,24}(?![\p{L}\p{N}_])/gu;

// ---------- keeping the index current ----------

function statements(db) {
  return {
    addTranscript: db.prepare('insert into transcripts(key) values(?)'),
    saveTranscript: db.prepare('update transcripts set size=?, mtime=?, offset=?, title=?, custom=?, cwd=?, first_at=?, last_at=? where id=?'),
    seen: db.prepare('insert or ignore into seen(transcript, hash) values(?, ?)'),
    word: db.prepare('insert or ignore into words(word, transcript) values(?, ?)'),
    chunk: db.prepare('insert into chunks(text, title, transcript, kind, at) values(?, ?, ?, ?, ?)'),
    retitle: db.prepare('update chunks set title=? where transcript=?'),
    bump: db.prepare("update meta set value = value + 1 where name = 'rev'"),
  };
}

function removeTranscript(db, id) {
  db.exec('begin immediate');
  try {
    db.prepare('delete from chunks where transcript = ?').run(id);
    db.prepare('delete from words where transcript = ?').run(id);
    db.prepare('delete from seen where transcript = ?').run(id);
    db.prepare('delete from transcripts where id = ?').run(id);
    db.prepare("update meta set value = value + 1 where name = 'rev'").run();
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}

function saveJob(db, q, job, row, st) {
  db.exec('begin immediate');
  try {
    const id = row ? row.id : Number(q.addTranscript.run(job.key).lastInsertRowid);
    if (row && row.title !== job.title) q.retitle.run(job.title, id);
    const words = new Set();
    for (const r of job.rows) {
      const hash = crypto.createHash('md5').update(`${r.kind}\0${r.text}`).digest().subarray(0, 8);
      if (!Number(q.seen.run(id, hash).changes)) continue; // the same text, logged again while streaming
      for (const piece of pieces(r.text)) q.chunk.run(piece, job.title, id, r.kind, r.at || 0);
      if (r.kind !== 'tool') for (const w of r.text.toLowerCase().match(WORD) || []) words.add(w);
    }
    for (const w of words) q.word.run(w, id);
    q.saveTranscript.run(st.size, st.mtimeMs, job.offset, job.title, job.custom, job.cwd, job.first, job.last, id);
    q.bump.run();
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}

/** Bring the index up to date with the transcripts on disk, newest first. */
async function update(onProgress) {
  if (!available()) return { indexed: 0, removed: 0 };
  const db = openWrite();
  try {
    const transcripts = claude.indexTranscripts(true);
    const known = new Map(db.prepare('select * from transcripts').all().map((r) => [r.key, r]));
    let removed = 0;
    for (const [key, row] of known) {
      if (transcripts[key]) continue;
      removeTranscript(db, row.id); // Claude deleted it, so its words go too
      known.delete(key);
      removed++;
    }
    const todo = [];
    for (const [key, file] of Object.entries(transcripts)) {
      let st;
      try {
        st = fs.statSync(file);
      } catch (_) {
        continue;
      }
      const row = known.get(key);
      if (!row || row.size !== st.size || row.mtime !== st.mtimeMs) todo.push({ key, file, st });
    }
    todo.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const total = Object.keys(transcripts).length;
    const q = statements(db);
    let left = todo.length;
    let told = 0;
    let indexed = 0;
    for (const { key, file, st } of todo) {
      try {
        let row = known.get(key);
        if (row && row.offset > st.size) {
          removeTranscript(db, row.id); // replaced by a shorter file: read it again from the start
          row = null;
        }
        const job = {
          key, rows: [], title: row ? row.title : '', custom: row ? row.custom : 0, cwd: row ? row.cwd : '',
          first: row ? row.first_at : 0, last: row ? row.last_at : 0, offset: 0,
        };
        job.offset = await claude.readLines(file, row ? row.offset : 0, st.size, (line) => handleLine(line, job));
        saveJob(db, q, job, row, st);
        indexed++;
      } catch (_) {
        // unreadable right now; tried again on the next pass
      }
      left--;
      if (onProgress && (Date.now() - told > 500 || !left)) {
        told = Date.now();
        onProgress({ left, total });
      }
    }
    if (todo.length >= 20) db.exec("insert into chunks(chunks) values('optimize')");
    if (indexed || removed) {
      db.exec('pragma wal_checkpoint(truncate)');
      vocab.rev = -1; // this process changed the words, so it need not wait to see them
    }
    return { indexed, removed, total };
  } finally {
    db.close();
  }
}

// The web server's side: one worker thread, one pass at a time.
let worker = null;
let running = false;
let again = false;
let timer = null;
let lastRun = 0;
let progress = { left: 0, total: 0 };

function finishRun(log) {
  running = false;
  lastRun = Date.now();
  progress.left = 0;
  if (again) {
    again = false;
    schedule(log);
  }
}

function startWorker(log) {
  const w = new Worker(__filename, { workerData: { taskboardSearch: true } });
  w.unref();
  w.on('message', (m) => {
    if (m.type === 'progress') progress = { left: m.left, total: m.total };
    else if (m.type === 'done') {
      if (m.error && log) log('search index:', m.error);
      finishRun(log);
    }
  });
  w.on('error', (e) => {
    if (log) log('search index:', e.message);
  });
  w.on('exit', () => {
    if (worker === w) worker = null;
    if (running) finishRun(log);
  });
  return w;
}

/** Ask for a pass. A burst of requests is one pass, and passes keep a gap between them. */
function schedule(log) {
  if (!available()) return;
  if (running) {
    again = true;
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    running = true;
    try {
      if (!worker) worker = startWorker(log);
      worker.postMessage('update');
    } catch (e) {
      if (log) log('search index:', e.message);
      finishRun(log);
    }
  }, Math.max(0, lastRun + UPDATE_GAP - Date.now()));
  timer.unref();
}

if (!isMainThread && workerData && workerData.taskboardSearch) {
  parentPort.on('message', async () => {
    try {
      const r = await update((p) => parentPort.postMessage({ type: 'progress', ...p }));
      parentPort.postMessage({ type: 'done', ...r });
    } catch (e) {
      parentPort.postMessage({ type: 'done', error: e.message });
    }
  });
}

// ---------- what comes out ----------

const STOP = new Set(
  'a an and are about after all also am as at be but by can did do does for from get got had has have how i if in into is it its me my no not of on or our she so some than that the their them then there these they this to up us was way we were what when where which who why will with would you your own'.split(' ')
);

/** Links count as what they point at: a pull request's number, a ticket's key, or the address. */
function linkTerm(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return raw;
  }
  const pr = /\/pull\/(\d+)/.exec(u.pathname);
  if (pr) return pr[1];
  const key = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,7}-\d{1,6})(?![A-Za-z0-9])/.exec(u.pathname);
  if (key) return key[1];
  return `${u.hostname}${u.pathname}`.replace(/\/+$/, '');
}

/** "Quoted phrases" have to appear. Other words are alternatives, ranked by how much they say. */
function parseQuery(q) {
  const required = [];
  const all = [];
  for (const m of String(q || '').slice(0, 500).matchAll(/"([^"]+)"|(\S+)/g)) {
    if (m[1]) {
      if (/[\p{L}\p{N}]/u.test(m[1])) required.push(m[1].trim());
      continue;
    }
    const raw = /^https?:\/\//i.test(m[2]) ? linkTerm(m[2]) : m[2];
    const t = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (t && !all.includes(t.toLowerCase())) all.push(t.toLowerCase());
  }
  const kept = all.filter((t) => !STOP.has(t));
  return { required: required.slice(0, 6), terms: (kept.length || required.length ? kept : all).slice(0, 12) };
}

const phrase = (t) => `"${t.replace(/"/g, '""')}"`;

function matchFor(required, terms) {
  const must = required.map(phrase);
  if (terms.length) must.push(terms.length > 1 ? `(${terms.map(phrase).join(' OR ')})` : phrase(terms[0]));
  return must.join(' AND ');
}

/** Edit distance with swapped neighbours counted once; gives up past `max`. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, before[j - 2] + 1);
      row.push(v);
      if (v < least) least = v;
    }
    if (least > max) return max + 1;
    before = prev;
    prev = row;
  }
  return prev[b.length];
}

const stem = (w) => w.replace(/(?:ies|ing|ed|es|s)$/, '');

let vocab = { rev: -1, at: 0, words: new Map() };
function vocabulary(db) {
  const rev = db.prepare("select value from meta where name = 'rev'").get().value;
  if (vocab.rev === -1 || (vocab.rev !== rev && Date.now() - vocab.at > 60000)) {
    const words = new Map();
    for (const r of db.prepare('select word, count(*) n from words group by word').all()) words.set(r.word, r.n);
    vocab = { rev, at: Date.now(), words };
  }
  return vocab.words;
}

/** The spelling a word was probably meant to have, judged by how often each appears. */
function corrections(terms, words) {
  const out = [];
  for (const w of terms) {
    if (w.length < 5 || w.length > 24 || !/^\p{L}+$/u.test(w)) continue;
    const own = words.get(w) || 0;
    if (own > 30) continue; // common enough to be meant
    const max = w.length >= 8 ? 2 : 1;
    const floor = Math.max(3, own * 1.5);
    let best = null;
    for (const [candidate, n] of words) {
      if (n < floor || candidate[0] !== w[0] || candidate === w || Math.abs(candidate.length - w.length) > max) continue;
      if (stem(candidate) === stem(w)) continue;
      const d = distance(w, candidate, max);
      if (d > max || (d === 2 && n < own * 4)) continue; // two edits away has to be far more likely
      if (!best || d < best.d || (d === best.d && n > best.n)) best = { word: candidate, d, n };
    }
    if (best) out.push({ from: w, to: best.word });
  }
  return out;
}

function sessionLookup(state) {
  const byKey = new Map();
  for (const s of (state && state.sessions) || []) {
    for (const key of [s.cliId, ...(s.priorCliIds || [])]) if (key) byKey.set(key, s);
  }
  return byKey;
}

function describe(group, state) {
  const s = group.session;
  if (!s) {
    return { id: group.id, exists: false, title: group.title || 'Untitled session', projectName: claude.projectOf(group.cwd || '').name, estate: '', archived: false, lastActivityAt: group.last, card: null };
  }
  const card = s.cardId && state.cards.find((c) => c.id === s.cardId);
  return {
    id: s.id, exists: true, source: s.source, title: s.title, projectName: s.projectName, estate: s.estate, archived: !!s.archived,
    lastActivityAt: s.lastActivityAt, card: card ? { id: card.id, key: card.key, title: card.title } : null,
  };
}

/** The sessions whose conversation best matches `q`. Matched words in `text` sit between \u0001 and \u0002. */
function query(q, opts) {
  const { limit, state, project } = opts || {};
  const parsed = parseQuery(q);
  const out = { q, terms: [...parsed.required, ...parsed.terms], corrected: [], total: 0, results: [] };
  if (!parsed.required.length && !parsed.terms.length) return out;
  const db = openRead();
  if (!db) return out;
  try {
    const base = matchFor(parsed.required, parsed.terms);
    out.corrected = corrections(parsed.terms, vocabulary(db));
    const wide = out.corrected.length ? matchFor(parsed.required, [...parsed.terms, ...out.corrected.map((c) => c.to)]) : base;

    const best = db.prepare(`select rowid id, transcript t, bm25(chunks, 1.0, ${TITLE_WEIGHT}.0) r from chunks where chunks match ? order by r limit ${CHUNK_LIMIT}`);
    const found = new Map();
    const collect = (match, factor) => {
      for (const row of best.all(match)) {
        const score = -row.r * factor;
        const had = found.get(row.id);
        if (!had || had.score < score) found.set(row.id, { t: row.t, score });
      }
    };
    collect(base, 1);
    if (wide !== base) collect(wide, FIX_WEIGHT);

    const transcripts = new Map(db.prepare('select id, key, title, cwd, last_at from transcripts').all().map((r) => [r.id, r]));
    const sessions = sessionLookup(state);
    const groups = new Map();
    for (const [rowid, c] of found) {
      const tr = transcripts.get(c.t);
      if (!tr) continue;
      const session = sessions.get(tr.key) || null;
      const id = session ? session.id : tr.key;
      if (!groups.has(id)) groups.set(id, { id, session, title: tr.title, cwd: tr.cwd, last: tr.last_at, passages: [] });
      groups.get(id).passages.push({ rowid, score: c.score });
    }
    let ranked = [...groups.values()];
    for (const g of ranked) {
      g.passages.sort((a, b) => b.score - a.score);
      const [a, b, c] = g.passages;
      g.score = a.score + 0.3 * (b ? b.score : 0) + 0.1 * (c ? c.score : 0);
    }
    if (project) ranked = ranked.filter((g) => g.session ? g.session.projectName === project || (g.session.alsoIn || []).includes(project) : claude.projectOf(g.cwd || '').name === project);
    ranked.sort((a, b) => b.score - a.score);
    out.total = ranked.length;
    // Show passages where the words really are: a session can rank on its title alone.
    const inText = new Map();
    for (const row of db.prepare(`select rowid id, transcript t, bm25(chunks) r from chunks where chunks match ? order by r limit ${CHUNK_LIMIT}`).all(`text : (${wide})`)) {
      const tr = transcripts.get(row.t);
      if (!tr) continue;
      const session = sessions.get(tr.key);
      const id = session ? session.id : tr.key;
      if (!inText.has(id)) inText.set(id, []);
      inText.get(id).push(row.id);
    }
    const clip = db.prepare("select snippet(chunks, 0, char(1), char(2), '…', 30) s, kind, at from chunks where chunks match ? and rowid = ?");
    const passagesOf = (g) => {
      const hits = [];
      for (const rowid of new Set([...(inText.get(g.id) || []).slice(0, 4), ...g.passages.slice(0, 6).map((p) => p.rowid)])) {
        const r = clip.get(wide, rowid);
        if (!r || !String(r.s).includes('\u0001')) continue;
        hits.push({ kind: r.kind, at: r.at, text: String(r.s).replace(/\s+/g, ' ').trim() });
        if (hits.length === 2) break;
      }
      return hits;
    };
    out.results = ranked.slice(0, Math.min(50, Math.max(1, Number(limit) || 12))).map((g) => ({ ...describe(g, state), hits: passagesOf(g) }));
  } catch (_) {
    // the index is being replaced, or the words could not be searched: nothing to show
  } finally {
    db.close();
  }
  return out;
}

/** How far the index has got. `left` is only known in the web server. */
function status() {
  if (!available()) return { available: false, ready: false, sessions: 0, left: 0, total: 0, node: process.versions.node };
  const db = openRead();
  let sessions = 0;
  if (db) {
    try {
      sessions = db.prepare('select count(*) c from transcripts').get().c;
    } catch (_) {
    } finally {
      db.close();
    }
  }
  let bytes = 0;
  for (const suffix of ['', '-wal']) {
    try {
      bytes += fs.statSync(DB_FILE + suffix).size;
    } catch (_) {}
  }
  return { available: true, ready: sessions > 0, sessions, bytes, left: running ? progress.left : 0, total: progress.total };
}

/** What the page asks for. */
function page(opts, state) {
  return { ok: true, ...query(opts.q, { limit: opts.limit, project: opts.project, state }), status: status() };
}

const LABEL = { prompt: 'You', answer: 'Claude', tool: 'Command' };

/** The same as text, for Claude and the terminal. */
function markdown(opts, state) {
  const st = status();
  if (!st.available) return `Searching inside conversations needs Node 22.13 or newer. This is Node ${st.node}.`;
  if (!st.ready) return 'The conversation index is not built yet. It is built by the board server: run `taskboard start`, give it a few seconds, and try again.';
  const r = query(opts.q, { limit: opts.limit || 10, project: opts.project, state });
  if (!r.terms.length) return 'Give some words to search for.';
  const view = require('./view');
  const L = [];
  if (r.corrected.length) L.push(`Also searched for: ${r.corrected.map((c) => `${c.to} (for ${c.from})`).join(', ')}.`);
  if (!r.results.length) {
    L.push(`No conversation matches "${opts.q}".`);
    return L.join('\n');
  }
  L.push(`${r.total} session${r.total === 1 ? '' : 's'} match, best first${r.total > r.results.length ? `; showing ${r.results.length}` : ''}:`, '');
  for (const s of r.results) {
    const bits = [s.id];
    if (s.exists) bits.push(view.STATE_LABEL[s.estate] + (s.archived ? ' (archived)' : ''));
    else bits.push('transcript only');
    bits.push(s.projectName, view.fmtDate(s.lastActivityAt), s.card ? `on ${s.card.key} ${s.card.title}` : 'not on a card');
    L.push(`- **${s.title}** · ${bits.join(' · ')}`);
    for (const h of s.hits) L.push(`  - ${LABEL[h.kind] || h.kind}: ${h.text.replace(/[\u0001\u0002]/g, '**')}`);
  }
  return L.join('\n');
}

module.exports = { available, update, schedule, query, page, status, markdown, redact, parseQuery, corrections, DB_FILE };
