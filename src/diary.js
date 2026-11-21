'use strict';
// The diary: what was worked on, day by day, and a search over it.
//
// It is a log, not a copy. From each transcript it keeps short, dated notes:
// the start of what was asked, the recap of each turn (or the start of
// Claude's closing reply when a turn has no recap), steps finished, commit
// subjects, pull requests and the names of files edited. Each note is capped
// in length and each session in notes per day, so a heavy day comes to a few
// KB, while the transcripts it was read from run to gigabytes and are deleted
// by Claude after a while.
//
//   diary/days/2026-11-18.json   what happened that day, by session
//   diary/sessions.json          each session's title, project and card when last seen
//   cache/diary/<id>.json        how far each transcript has been read (safe to delete)
//
// A day's file is only rewritten on that day. A transcript is read once, then
// only what was appended to it. Only the web server writes; the MCP server and
// the CLI read.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const claude = require('./claude');

const V = 1;
const DAYS_DIR = path.join(P.DIARY_DIR, 'days');
const REG_FILE = path.join(P.DIARY_DIR, 'sessions.json');
const READ_DIR = path.join(P.CACHE_DIR, 'diary');

// Entry kinds:  p  what the user asked        a  how Claude's closing reply began
//               r  the recap of a turn         s  a step that got finished
//               c  a commit                    pr a pull request
//               f  a file edited               o  the session was open (nothing to read)
const MAX = { p: 400, a: 300, r: 500, s: 160, c: 160, f: 200 }; // characters kept per entry
const CAP = { p: 60, a: 40, r: 40, s: 60, c: 40, f: 60, pr: 20, o: 1 }; // entries kept per session per day

let rev = Date.now(); // goes up whenever what the diary would show has changed; never repeats across restarts
let notes = {};
let notesSig = '{}';
let progress = { total: 0, left: 0 };

// ---------- small helpers ----------

const pad = (n) => String(n).padStart(2, '0');
/** The local calendar day of a time, as YYYY-MM-DD. */
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function shiftDay(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d + n).getTime());
}
/** "today", "yesterday" or a date, as a day. */
function parseDay(text) {
  const t = String(text || '').trim().toLowerCase();
  const today = dayOf(Date.now());
  if (!t || t === 'today') return today;
  if (t === 'yesterday') return shiftDay(today, -1);
  return isDay(t) ? t : '';
}
function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Text kept readable: runs of blanks squeezed, line breaks kept, cut at `max`. */
function clip(s, max) {
  const t = String(s || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const safeKey = (key) => /^[\w-]{8,90}$/.test(String(key || ''));

function write(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- what is known about each session ----------

let reg = null; // { v, history, s: { transcript id -> { sid, title, project, card, … } } }
let regDirty = false;
let regLocked = false;

function registry() {
  if (reg) return reg;
  let text = null;
  try {
    text = fs.readFileSync(REG_FILE, 'utf8');
  } catch (_) {}
  let j = null;
  try {
    j = text === null ? null : JSON.parse(text);
  } catch (_) {}
  if (j && j.v === V && j.s && typeof j.s === 'object') reg = j;
  else {
    reg = { v: V, history: 0, s: {} };
    regLocked = text !== null; // written by a newer version, or damaged: read around it, never over it
  }
  return reg;
}

// ---------- the days ----------

const days = new Map(); // day -> { day, s: { transcript id -> [entries] }, sigs, bytes, locked, view }
const dirty = new Set();
let allLoaded = false;

const dayFile = (day) => path.join(DAYS_DIR, `${day}.json`);

function dayData(day, create) {
  let d = days.get(day);
  if (d) return d;
  let buf = null;
  try {
    buf = fs.readFileSync(dayFile(day));
  } catch (_) {}
  if (buf) {
    let j = null;
    try {
      j = JSON.parse(buf.toString('utf8'));
    } catch (_) {}
    const ok = j && j.v === V && j.s && typeof j.s === 'object';
    d = { day, s: ok ? j.s : {}, sigs: null, bytes: buf.length, locked: !ok, view: null };
  } else if (create) d = { day, s: {}, sigs: null, bytes: 0, locked: false, view: null };
  else return null;
  days.set(day, d);
  return d;
}

function loadAll() {
  if (allLoaded) return;
  allLoaded = true;
  let names = [];
  try {
    names = fs.readdirSync(DAYS_DIR);
  } catch (_) {}
  for (const f of names) if (f.endsWith('.json') && isDay(f.slice(0, -5))) dayData(f.slice(0, -5), false);
}

/** Forget what was read from disk. For the MCP server and the CLI, which only ever read. */
function refresh() {
  reg = null;
  regDirty = false;
  days.clear();
  dirty.clear();
  allLoaded = false;
}

// An entry is the same entry wherever it is read from. That makes reading a
// transcript again harmless, and stops a forked session (whose transcript
// repeats its parent's) from claiming its parent's day.
const sigOf = (key, e) => (e.k === 'o' ? `o|${key}` : `${e.k}|${e.t}|${(e.x || e.url || '').slice(0, 40)}`);

function sigsOf(d) {
  if (!d.sigs) {
    d.sigs = new Set();
    for (const [key, list] of Object.entries(d.s)) for (const e of list) d.sigs.add(sigOf(key, e));
  }
  return d.sigs;
}

function put(key, e) {
  if (!e.t) return false;
  const d = dayData(dayOf(e.t), true);
  if (d.locked) return false;
  const sigs = sigsOf(d);
  const sig = sigOf(key, e);
  if (sigs.has(sig)) return false;
  const list = d.s[key] || (d.s[key] = []);
  let same = 0;
  for (const x of list) if (x.k === e.k) same++;
  if (same >= CAP[e.k]) return false;
  list.push(e);
  sigs.add(sig);
  d.view = null;
  dirty.add(d.day);
  return true;
}

function drop(key, at, kind) {
  const d = dayData(dayOf(at), false);
  if (!d || d.locked || !d.s[key]) return;
  const keep = d.s[key].filter((e) => !(e.k === kind && e.t === at));
  if (keep.length === d.s[key].length) return;
  d.s[key] = keep;
  d.sigs = null;
  d.view = null;
  dirty.add(d.day);
}

/** Write the days that changed. Returns how many. */
function flush() {
  let n = 0;
  for (const day of [...dirty]) {
    const d = days.get(day);
    for (const key of Object.keys(d.s)) {
      if (!d.s[key].length) delete d.s[key];
      else d.s[key].sort((a, b) => a.t - b.t);
    }
    const text = JSON.stringify({ v: V, day, s: d.s });
    if (!write(dayFile(day), text)) continue; // stays dirty, tried again on the next change
    d.bytes = Buffer.byteLength(text);
    dirty.delete(day);
    n++;
  }
  if (regDirty && !regLocked && write(REG_FILE, JSON.stringify(reg))) regDirty = false;
  return n;
}

// ---------- reading a transcript ----------

const readers = new Map(); // transcript id -> { size, mtimeMs, offset, st }
let readersLoaded = false;

function freshReader(key) {
  return {
    v: V, key, size: 0, mtimeMs: 0, offset: 0,
    st: { plan: [], seen: [], prs: [], pend: null, pa: 0, rs: 0, t: 0, ct: 0, title: '', cwd: '', br: [], lp: [], lc: null, prTitle: '', fday: '', fseen: [] },
  };
}

function loadReaders() {
  if (readersLoaded) return;
  readersLoaded = true;
  let names = [];
  try {
    names = fs.readdirSync(READ_DIR);
  } catch (_) {}
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const u = JSON.parse(fs.readFileSync(path.join(READ_DIR, f), 'utf8'));
      if (u && u.v === V && u.key && u.st) readers.set(u.key, u);
    } catch (_) {}
  }
}

const PLAN_TOOLS = /^(mcp__ccd_turn__update_plan|mcp__ccd_turn__wrap_up|TodoWrite|TaskCreate|TaskUpdate)$/;
const FILE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
// git … commit where a command starts, not the words somewhere in an argument
const GIT_COMMIT = /(?:^|[;&|(\n])\s*(?:[A-Z_]+=\S+\s+)*git\b[^\n|;&]*\bcommit\b/g;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?!\w)/g;
// slash commands that set Claude up rather than ask for work
const SETUP = /^\/(compact|clear|model|fast|config|help|login|logout|status|cost|resume|exit|quit|mcp|permissions|usage|context|rename|effort|plugin|agents|memory|doctor|ide|vim|add-dir|hooks|export|statusline|output-style|upgrade|terminal-setup|release-notes|theme)(\s|$)/;

const B = (s) => Buffer.from(s);
const IS_API = B('"type":"api-request');
const IS_PR = B('"type":"pr-link"');
const IS_TITLE = B('-title"');
const IS_ASSISTANT = B('"type":"assistant"');
const IS_USER = B('"type":"user"');
const HAS_TOOL = B('"type":"tool_use"');
const HAS_TEXT = B('"type":"text"');
const HAS_RESULT = B('"type":"tool_result"');
const HAS_RESULT2 = B('"toolUseResult"');
const HAS_QUEUED = B('"queued_command"');
const HAS_BASH = B('"name":"Bash"');
const TOOL_HINTS = ['update_plan', 'wrap_up', '"TodoWrite"', '"TaskCreate"', '"TaskUpdate"', '"name":"Edit"', '"name":"Write"', '"name":"MultiEdit"', '"name":"NotebookEdit"'].map(B);
const BASH_HINTS = ['commit', 'gh pr create'].map(B);

const stamp = (o) => (o && o.timestamp ? Date.parse(o.timestamp) || 0 : 0);

/** The user's own words, without the blocks the app wraps around them. */
function promptText(raw) {
  const t = claude.cleanPrompt(String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim());
  return !t || /^(Caveat:|\[Request interrupted)/.test(t) ? '' : t;
}

function humanText(content) {
  const texts = [];
  let images = 0;
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text' && b.text) texts.push(b.text);
      else if (b && b.type === 'image') images++;
    }
  }
  return texts.map(promptText).filter(Boolean).join('\n') || (images ? '(an image)' : '');
}

/**
 * Claude's last words before the next prompt are its answer to the one before.
 * Until that next prompt comes, the latest text stands in, so a session's last
 * turn shows too; `final` says the turn is over. A turn with a recap keeps the
 * recap and no answer.
 */
function settleAnswer(u, final) {
  const st = u.st;
  if (!final && st.pa && st.pend && st.pa === st.pend.t && !st.rs) return; // already standing in, and nothing newer
  if (st.pa) {
    drop(u.key, st.pa, 'a');
    st.pa = 0;
  }
  const p = st.pend;
  if (!p) return;
  if (final) st.pend = null;
  if (st.rs) return;
  if (put(u.key, { t: p.t, k: 'a', x: p.x }) && !final) st.pa = p.t;
}

function addPrompt(u, text, at) {
  if (!text || !at) return;
  settleAnswer(u, true);
  if (SETUP.test(text)) return;
  const x = clip(text, MAX.p);
  // a prompt typed while Claude was busy is logged when queued and again when taken up
  if (u.st.lp.some((l) => l.x === x.slice(0, 80) && Math.abs(l.t - at) < 600e3)) return;
  u.st.lp.push({ x: x.slice(0, 80), t: at });
  if (u.st.lp.length > 4) u.st.lp.shift();
  put(u.key, { t: at, k: 'p', x });
  u.st.rs = 0;
}

function planCall(u, name, input, at) {
  const before = new Map(u.st.plan.map((i) => [i.content, i.status]));
  const d = { plan: u.st.plan, planAt: 0, wrap: null };
  claude.applyPlanCall(d, name, input, at);
  u.st.plan = d.plan;
  if (!at) return;
  for (const i of d.plan) {
    if (i.status === 'completed' && before.get(i.content) !== 'completed') put(u.key, { t: at, k: 's', x: clip(i.content, MAX.s) });
  }
  if (d.wrap && input && input.recap) {
    put(u.key, { t: at, k: 'r', x: clip(input.recap, MAX.r) });
    u.st.rs = 1;
  }
}

/** Where a command runs git commit, or -1. Text inside a heredoc is a file being written, not a command. */
function commitAt(command) {
  const bodies = [];
  for (const m of command.matchAll(HEREDOC)) bodies.push([m.index + m[0].indexOf('\n'), m.index + m[0].length]);
  for (const m of command.matchAll(GIT_COMMIT)) {
    if (!bodies.some(([from, to]) => m.index >= from && m.index < to)) return m.index;
  }
  return -1;
}

/** The subject line of `git commit -m …`, including the heredoc form; '' when the command does not commit. */
function commitMessage(command) {
  const start = commitAt(command);
  if (start === -1) return '';
  const rest = command.slice(start);
  const flag = /\s-(?:[a-zA-Z]*m|-message)[ =]+/.exec(rest);
  if (!flag) return '';
  let s = rest.slice(flag.index + flag[0].length);
  const heredoc = /^"?\$\(cat\s+<<-?\s*['"]?(\w+)['"]?[^\n]*\n/.exec(s);
  if (heredoc) s = s.slice(heredoc[0].length);
  else if (s[0] === '"' || s[0] === "'") {
    const quote = s[0];
    let end = -1;
    for (let i = 1; i < s.length; i++) {
      if (s[i] === '\\' && quote === '"') i++;
      else if (s[i] === quote) {
        end = i;
        break;
      }
    }
    s = s.slice(1, end === -1 ? undefined : end);
  } else s = s.split(/\s/)[0];
  const first = s.split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (heredoc && first === heredoc[1]) return '';
  return clip(first.replace(/\\(["'$`\\])/g, '$1'), MAX.c);
}

function bashCall(u, command, at) {
  if (typeof command !== 'string' || !at) return;
  if (command.includes('commit')) {
    const msg = commitMessage(command);
    const prev = u.st.lc;
    // a commit retried after a failed hook, or amended, is still one commit
    if (msg && !(prev && prev.x === msg && at - prev.t < 3600e3)) {
      put(u.key, { t: at, k: 'c', x: msg });
      u.st.lc = { x: msg, t: at };
    }
  }
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    const m = /--title[=\s]+(["'])([\s\S]*?)\1/.exec(command);
    if (m) u.st.prTitle = clip(m[2], MAX.c);
  }
}

function fileCall(u, file, at) {
  if (typeof file !== 'string' || !file || !at) return;
  const st = u.st;
  const day = dayOf(at);
  if (st.fday !== day) {
    st.fday = day;
    st.fseen = [];
  }
  // once per file per day, by its path inside the project
  const name = (st.cwd && file.startsWith(st.cwd + '/') ? file.slice(st.cwd.length + 1) : file.replace(/^\/(?:Users|home)\/[^/]+/, '~')).slice(-MAX.f);
  if (st.fseen.includes(name) || st.fseen.length >= CAP.f) return;
  st.fseen.push(name);
  put(u.key, { t: at, k: 'f', x: name });
}

function prLink(u, o) {
  const url = String(o.prUrl || '');
  if (!/^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url) || u.st.prs.includes(url)) return;
  const at = stamp(o) || u.st.t;
  if (!at) return;
  u.st.prs.push(url);
  if (u.st.prs.length > 40) u.st.prs.shift();
  put(u.key, { t: at, k: 'pr', x: u.st.prTitle || '', n: Number(o.prNumber) || 0, url, repo: String(o.prRepository || '').slice(0, 120) });
  u.st.prTitle = '';
}

function assistantLine(u, o) {
  const at = stamp(o) || u.st.t;
  if (at) u.st.t = at;
  const content = o.message && o.message.content;
  if (!Array.isArray(content) || o.isApiErrorMessage) return;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') {
      if (at && b.text && b.text.trim()) u.st.pend = { t: at, x: clip(b.text, MAX.a) };
      continue;
    }
    if (b.type !== 'tool_use') continue;
    if (b.id) {
      if (u.st.seen.includes(b.id)) continue; // the same call can be logged twice while streaming
      u.st.seen.push(b.id);
      if (u.st.seen.length > 16) u.st.seen.shift();
    }
    const name = b.name || '';
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    if (PLAN_TOOLS.test(name)) planCall(u, name, input, at);
    else if (name === 'Bash') bashCall(u, input.command, at);
    else if (FILE_TOOLS.test(name)) fileCall(u, input.file_path || input.notebook_path, at);
  }
}

function userLine(u, o) {
  const at = stamp(o) || u.st.t;
  if (at) u.st.t = at;
  if (o.isMeta || o.isCompactSummary || o.toolUseResult) return;
  if (o.origin && o.origin.kind && o.origin.kind !== 'human') return; // a scheduled run or a background task reporting in
  if (!u.st.cwd && o.cwd) u.st.cwd = String(o.cwd);
  const branch = o.gitBranch;
  if (branch && branch !== 'HEAD' && !u.st.br.includes(branch) && u.st.br.length < 6) u.st.br.push(String(branch).slice(0, 100));
  addPrompt(u, humanText(o.message && o.message.content), at);
}

/**
 * One transcript line. Most of a transcript is tool output, so a line is only
 * decoded when a cheap byte search says it holds something the diary keeps.
 */
function handleLine(buf, u) {
  if (buf.length < 40) return;
  const head = buf.length > 512 ? buf.subarray(0, 512) : buf;
  const start = head.subarray(0, 40);
  if (start.includes(IS_API)) return;
  try {
    if (start.includes(IS_PR)) return prLink(u, JSON.parse(buf.toString('utf8')));
    if (start.includes(IS_TITLE)) {
      if (buf.length > 4000) return;
      const o = JSON.parse(buf.toString('utf8'));
      if (o.type === 'custom-title' && o.customTitle) {
        u.st.title = claude.trimText(o.customTitle, 160);
        u.st.ct = 1;
      } else if (o.type === 'ai-title' && o.aiTitle && !u.st.ct) u.st.title = claude.trimText(o.aiTitle, 160);
      return;
    }
    // the record's type sits near its start; only look further when it does not
    let kind = head.includes(IS_ASSISTANT) ? 'a' : head.includes(IS_USER) ? 'u' : '';
    if (kind === 'u' && head.includes(HAS_RESULT)) return; // tool output: the bulk of every transcript
    if (!kind && buf !== head) kind = buf.includes(IS_ASSISTANT) ? 'a' : buf.includes(IS_USER) ? 'u' : '';
    let want = false;
    if (kind === 'a' && buf.length < 4e6) {
      if (buf.includes(HAS_TOOL)) want = TOOL_HINTS.some((h) => buf.includes(h)) || (buf.includes(HAS_BASH) && BASH_HINTS.some((h) => buf.includes(h)));
      else want = buf.includes(HAS_TEXT);
    } else if (kind === 'u') {
      // a prompt with a pasted image is a long line, so the limit here is generous
      want = buf.length < 4e7 && !buf.includes(HAS_RESULT) && !buf.includes(HAS_RESULT2);
    }
    if (!want && buf.includes(HAS_QUEUED)) want = buf.length < 4e6;
    if (!want) return;
    const o = JSON.parse(buf.toString('utf8'));
    if (!o || o.isSidechain) return;
    if (o.type === 'assistant') return assistantLine(u, o);
    if (o.type === 'user') return userLine(u, o);
    if (o.type === 'attachment') {
      const a = o.attachment || {};
      if (a.type !== 'queued_command' || a.commandMode !== 'prompt') return;
      const origin = a.origin || o.origin;
      if (origin && origin.kind && origin.kind !== 'human') return;
      return addPrompt(u, humanText(a.prompt), stamp(o) || stamp(a) || u.st.t);
    }
  } catch (_) {
    // a half-written or odd line: nothing to keep
  }
}

async function readUnit(key, file, st) {
  let u = readers.get(key);
  if (!u || u.offset > st.size) u = freshReader(key); // new, or replaced by a shorter file: entries already kept are not added twice
  u.offset = await claude.readLines(file, u.offset, st.size, (line) => handleLine(line, u));
  settleAnswer(u, false);
  u.size = st.size;
  u.mtimeMs = st.mtimeMs;
  readers.set(key, u);
  const r = registry();
  const m = r.s[key] || (r.s[key] = {});
  const branches = u.st.br.join(' ');
  if (!m.read || (m.tt || '') !== u.st.title || (m.cwd || '') !== u.st.cwd || (m.br || '') !== branches) {
    m.read = 1;
    if (u.st.title) m.tt = u.st.title;
    if (u.st.cwd) m.cwd = u.st.cwd;
    if (branches) m.br = branches;
    regDirty = true;
  }
  // the days first, then how far we got: after a crash the same lines are read again and change nothing
  const wrote = flush();
  write(path.join(READ_DIR, `${key}.json`), JSON.stringify(u));
  return wrote;
}

/**
 * Prompts typed in a terminal are also in ~/.claude/history.jsonl, which
 * reaches further back than the transcripts do. Used once, for sessions whose
 * transcript was already gone when the diary started.
 */
function importHistory() {
  const r = registry();
  if (r.history) return 0;
  let text = '';
  try {
    text = fs.readFileSync(P.HISTORY_FILE, 'utf8');
  } catch (_) {}
  const transcripts = claude.indexTranscripts();
  let added = 0;
  for (const line of text.split('\n')) {
    if (line.length < 20) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const key = o && o.sessionId;
    const at = Number(o && o.timestamp) || 0;
    if (!safeKey(key) || !at || transcripts[key] || (r.s[key] && r.s[key].read)) continue;
    const prompt = promptText(o.display);
    if (!prompt || SETUP.test(prompt)) continue;
    if (!put(key, { t: at, k: 'p', x: clip(prompt, MAX.p) })) continue;
    added++;
    const m = r.s[key] || (r.s[key] = {});
    if (!m.cwd && typeof o.project === 'string') m.cwd = o.project;
  }
  r.history = 1;
  regDirty = true;
  flush();
  return added;
}

let crawling = false;
/**
 * Bring the diary up to date with the transcripts on disk, newest first.
 * `onChange` is called now and then while a long first read is under way.
 */
async function crawl(onChange) {
  if (crawling) return;
  crawling = true;
  try {
    loadReaders();
    const transcripts = claude.indexTranscripts();
    const todo = [];
    let total = 0;
    for (const [key, file] of Object.entries(transcripts)) {
      if (!safeKey(key)) continue;
      total++;
      let st;
      try {
        st = fs.statSync(file);
      } catch (_) {
        continue;
      }
      const u = readers.get(key);
      if (!u || u.size !== st.size || u.mtimeMs !== st.mtimeMs) todo.push({ key, file, st });
    }
    // Claude deleted the transcript: its reading position goes too. The days it filled stay.
    for (const key of [...readers.keys()]) {
      if (transcripts[key]) continue;
      readers.delete(key);
      try {
        fs.unlinkSync(path.join(READ_DIR, `${key}.json`));
      } catch (_) {}
    }
    todo.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    progress = { total, left: todo.length };
    const long = todo.length > 5;
    let changed = false;
    let told = Date.now();
    for (const job of todo) {
      try {
        if (await readUnit(job.key, job.file, job.st)) changed = true;
      } catch (_) {
        // unreadable right now; tried again on the next pass
      }
      progress.left--;
      if (long && Date.now() - told > 1500) {
        told = Date.now();
        rev++;
        changed = false;
        if (onChange) onChange();
      }
    }
    if (importHistory()) changed = true;
    progress.left = 0;
    if (changed || long) {
      rev++;
      if (onChange) onChange();
    }
  } finally {
    progress.left = 0;
    crawling = false;
  }
}

/**
 * Remember how each session looks now (title, project, card), so a day in the
 * diary still makes sense after the session is archived or deleted in Claude.
 */
function sync(state) {
  const r = registry();
  const cards = new Map(state.cards.map((c) => [c.id, c]));
  let changed = false;
  for (const s of state.sessions) {
    const card = s.cardId ? cards.get(s.cardId) : null;
    const keys = (s.cliId ? [s.cliId, ...(s.priorCliIds || [])] : [s.id]).filter(safeKey);
    for (const key of keys) {
      const m = r.s[key] || (r.s[key] = {});
      // Claude dropped the session but its transcript is still on disk, so it now looks like a
      // terminal session named after its first prompt: keep what the diary knew it as
      if (s.source === 'cli' && m.sid && m.sid !== s.id) continue;
      const had = m.card || null;
      if (
        m.sid === s.id && m.title === s.title && m.project === s.projectName && m.source === s.source && !!m.archived === !!s.archived &&
        (had ? had.key : '') === (card ? card.key : '') && (had ? had.title : '') === (card ? card.title : '')
      ) continue;
      m.sid = s.id;
      m.title = s.title;
      m.project = s.projectName;
      m.source = s.source;
      if (s.archived) m.archived = 1;
      else delete m.archived;
      if (card) m.card = { key: card.key, title: card.title };
      else delete m.card;
      changed = true;
    }
    // Nothing to read for it (its transcript was gone before the diary started, or it ran
    // on another machine): keep the day it was opened and what it last reported.
    const m = r.s[keys[0]];
    if (m && !m.read && !s.hasTranscript && s.lastActivityAt && m.seenAt !== s.lastActivityAt) {
      if (m.seenAt) drop(keys[0], m.seenAt, 'r');
      if (s.createdAt) put(keys[0], { t: s.createdAt, k: 'o', x: '' });
      const recap = clip(s.wrapUp || s.lastReport || (s.summary && s.summary.detail) || '', MAX.r);
      put(keys[0], recap ? { t: s.lastActivityAt, k: 'r', x: recap } : { t: s.lastActivityAt, k: 'o', x: '' });
      m.seenAt = s.lastActivityAt;
      changed = true;
    }
  }
  if (changed) {
    regDirty = true;
    rev++;
  }
  flush();
}

/** The title a session had when the board last saw it; '' when it never did. */
function titleOf(sessionId) {
  const r = registry().s;
  for (const key of Object.keys(r)) if (r[key].sid === sessionId && r[key].title) return r[key].title;
  return '';
}

function setNotes(n) {
  const sig = JSON.stringify(n || {});
  if (sig === notesSig) return;
  notesSig = sig;
  notes = n || {};
  rev++;
}

// ---------- reading the diary ----------

function liveOf(state) {
  return {
    sessions: new Map(state.sessions.map((s) => [s.id, s])),
    cards: new Map(state.cards.map((c) => [c.id, c])),
    cardKeys: new Map(state.cards.map((c) => [c.key, c])),
  };
}

/** A day's entries grouped by session: the two halves of a resumed session are one. */
function blocksOf(d) {
  if (d.view && d.view.rev === rev) return d.view.blocks;
  const r = registry().s;
  const by = new Map();
  for (const [key, list] of Object.entries(d.s)) {
    if (!list.length) continue;
    const gid = (r[key] && r[key].sid) || key;
    let b = by.get(gid);
    if (!b) by.set(gid, (b = { gid, keys: [], entries: [], first: Infinity, last: 0 }));
    b.keys.push(key);
    for (const e of list) {
      b.entries.push(e);
      if (e.t < b.first) b.first = e.t;
      if (e.t > b.last) b.last = e.t;
    }
  }
  const blocks = [...by.values()].sort((a, b) => a.first - b.first);
  for (const b of blocks) b.entries.sort((x, y) => x.t - y.t);
  d.view = { rev, blocks };
  return blocks;
}

/** Who a block of entries belongs to: the session as it is now, or as it was last seen. */
function describe(b, live) {
  const r = registry().s;
  const s = live.sessions.get(b.gid) || null;
  const ms = b.keys.map((k) => r[k]).filter(Boolean);
  const m = ms.find((x) => x.sid) || ms[0] || {};
  const firstPrompt = (b.entries.find((e) => e.k === 'p') || {}).x || '';
  let card = null;
  if (s && s.cardId && live.cards.has(s.cardId)) card = live.cards.get(s.cardId);
  else if (!s && m.card) card = live.cardKeys.get(m.card.key) || { id: '', key: m.card.key, title: m.card.title };
  return {
    id: b.gid,
    exists: !!s, // still a session in Claude
    source: (s && s.source) || m.source || 'cli',
    archived: s ? !!s.archived : !!m.archived,
    title: (s && s.title) || m.title || claude.cleanPrompt(m.tt || '') || claude.trimText(firstPrompt, 90) || 'Untitled session',
    projectName: (s && s.projectName) || m.project || claude.projectOf(m.cwd || '').name,
    card: card ? { id: card.id, key: card.key, title: card.title } : null,
    branches: [...new Set(ms.flatMap((x) => (x.br ? x.br.split(' ') : [])))].slice(0, 6),
    // a session read from its transcript has its pull requests as entries, on the day each was linked
    prs: s && !ms.some((x) => x.read) ? (s.prs || []).slice(0, 6) : [],
  };
}

const pub = (e) => (e.k === 'pr' ? { t: e.t, k: e.k, x: e.x || '', n: e.n, url: e.url, repo: e.repo } : { t: e.t, k: e.k, x: e.x || '' });

let listCache = null;
/** Every day with something in it, newest first: [day, sessions, prompts]. */
function dayList(live, project) {
  if (listCache && listCache.rev === rev && listCache.project === project) return listCache.list;
  loadAll();
  const list = [];
  for (const d of days.values()) {
    let n = 0;
    let p = 0;
    for (const b of blocksOf(d)) {
      if (project && describe(b, live).projectName !== project) continue;
      n++;
      for (const e of b.entries) if (e.k === 'p') p++;
    }
    if (n) list.push([d.day, n, p]);
  }
  for (const day of Object.keys(notes)) if (isDay(day) && !list.some((x) => x[0] === day)) list.push([day, 0, 0]);
  list.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  listCache = { rev, project, list };
  return list;
}

function dayPage(day, live, project, list) {
  const d = dayData(day, false);
  const totals = { sessions: 0, prompts: 0, steps: 0, commits: 0, prs: 0, files: 0, first: 0, last: 0, projects: [] };
  const sessions = [];
  for (const b of d ? blocksOf(d) : []) {
    const info = describe(b, live);
    if (project && info.projectName !== project) continue;
    const entries = b.entries.map(pub);
    sessions.push({ ...info, first: b.first, last: b.last, entries });
    totals.sessions++;
    for (const e of entries) {
      if (e.k === 'p') totals.prompts++;
      else if (e.k === 's') totals.steps++;
      else if (e.k === 'c') totals.commits++;
      else if (e.k === 'pr') totals.prs++;
      else if (e.k === 'f') totals.files++;
    }
    totals.prs += info.prs.length;
    if (!totals.first || b.first < totals.first) totals.first = b.first;
    if (b.last > totals.last) totals.last = b.last;
    if (info.projectName && !totals.projects.includes(info.projectName)) totals.projects.push(info.projectName);
  }
  const older = list.find((x) => x[0] < day);
  const newer = [...list].reverse().find((x) => x[0] > day);
  return { day, note: (notes[day] && notes[day].text) || '', prev: older ? older[0] : '', next: newer ? newer[0] : '', totals, sessions };
}

// ---------- search ----------

const lowered = new WeakMap();
function lower(e) {
  let s = lowered.get(e);
  if (s === undefined) lowered.set(e, (s = (e.x || '').toLowerCase()));
  return s;
}

/**
 * Words, and "quoted phrases", all of which must be found. Each is a list of
 * spellings, any of which will do: a word also matches its plural or singular
 * ("diary" finds "diaries"); a quoted phrase only itself.
 */
function terms(q) {
  const out = [];
  for (const m of String(q || '').toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] || m[2] || '').trim();
    if (!t || out.length >= 8 || out.some((o) => o[0] === t)) continue;
    const forms = [t];
    if (!m[1] && t.length > 3) {
      if (t.endsWith('ies')) forms.push(t.slice(0, -3) + 'y');
      else if (t.endsWith('y')) forms.push(t.slice(0, -1) + 'ies');
      else if (t.endsWith('s') && !t.endsWith('ss')) forms.push(t.slice(0, -1));
    }
    out.push(forms);
  }
  return out;
}
const has = (text, term) => term.some((form) => text.includes(form));

function snippet(text, words, max) {
  if (text.length <= max) return text;
  const low = text.toLowerCase();
  let at = -1;
  for (const w of words.flat()) {
    const i = low.indexOf(w);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const from = Math.max(0, (at === -1 ? 0 : at) - Math.round(max * 0.3));
  return (from ? '…' : '') + text.slice(from, from + max).trim() + (from + max < text.length ? '…' : '');
}

function search(q, live, project, limit) {
  const words = terms(q);
  const out = { q, terms: words.flat(), total: 0, days: [], items: [] };
  if (!words.length) return out;
  loadAll();
  const max = limit || 200;
  const all = new Set([...days.keys(), ...Object.keys(notes).filter(isDay)]);
  for (const day of [...all].sort().reverse()) {
    let found = 0;
    const note = notes[day] && notes[day].text;
    if (note && !project && words.every((w) => has(note.toLowerCase(), w))) {
      found++;
      if (out.items.length < max) out.items.push({ day, note: snippet(note, words, 300) });
    }
    const d = days.get(day);
    for (const b of d ? blocksOf(d) : []) {
      const info = describe(b, live);
      if (project && info.projectName !== project) continue;
      const head = [info.title, info.projectName, info.card ? `${info.card.key} ${info.card.title}` : '', info.branches.join(' ')].join(' ').toLowerCase();
      // every word has to come up in that session's day: in its name, or in any of its entries
      if (!words.every((w) => has(head, w) || b.entries.some((e) => e.x && has(lower(e), w)))) continue;
      let hits = b.entries.filter((e) => e.x && words.some((w) => has(lower(e), w)));
      // only the session's name matched: show how its day started
      if (!hits.length) hits = b.entries.filter((e) => e.x && e.k !== 'f').slice(0, 2);
      found++;
      if (out.items.length < max) {
        out.items.push({
          day, ...info, first: b.first, last: b.last,
          hits: hits.slice(0, 5).map((e) => ({ ...pub(e), x: snippet(e.x, words, 260) })),
          more: Math.max(0, hits.length - 5),
        });
      }
    }
    if (found) {
      out.total += found;
      out.days.push([day, found]);
    }
  }
  return out;
}

// ---------- what the page, the MCP tools and the CLI ask for ----------

function stats() {
  loadAll();
  let bytes = 0;
  for (const d of days.values()) bytes += d.bytes;
  return { days: days.size, bytes };
}

/** Everything the Diary tab shows: the list of days, and one day or the search results. */
function page(opts, state) {
  const live = liveOf(state);
  const project = String(opts.project || '');
  const list = dayList(live, project);
  const today = dayOf(Date.now());
  const out = { ok: true, v: rev, today, progress: { ...progress }, stats: stats(), days: list, day: null, results: null };
  const q = String(opts.q || '').trim();
  if (q) out.results = search(q, live, project, 200);
  else {
    // no day asked for: the latest one with something in it
    const day = isDay(opts.day) ? opts.day : (list.find((x) => x[0] <= today) || [today])[0];
    out.day = dayPage(day, live, project, list);
  }
  return out;
}

const KIND = { p: 'asked', a: 'Claude', r: 'recap', s: 'done', c: 'commit', pr: 'PR', f: 'file' };

function sessionHead(s) {
  return [
    `${clock(s.first)}–${clock(s.last)}`, s.title, s.projectName, s.card ? `${s.card.key} ${s.card.title}` : '',
    s.exists ? (s.archived ? 'archived' : '') : 'no longer in Claude', s.exists && s.source !== 'cli' ? s.id : '',
  ].filter(Boolean).join(' · ');
}

function entryLine(e, max) {
  if (e.k === 'pr') return `- ${clock(e.t)} PR: ${e.repo}#${e.n}${e.x ? ` ${e.x}` : ''} ${e.url}`;
  return `- ${clock(e.t)} ${KIND[e.k] || e.k}: ${claude.trimText(e.x, max)}`;
}

/** The same as text, for Claude and the terminal: one or more days, or a search. */
function markdown(opts, state) {
  const live = liveOf(state);
  const project = String(opts.project || '');
  const L = [];
  if (String(opts.q || '').trim()) {
    const r = search(opts.q, live, project, Math.min(60, Math.max(1, Number(opts.limit) || 25)));
    if (!r.total) return `Nothing in the diary matches "${opts.q}".`;
    L.push(`${r.total} match${r.total === 1 ? '' : 'es'} for "${opts.q}" on ${r.days.length} day${r.days.length === 1 ? '' : 's'}${r.total > r.items.length ? `, showing the ${r.items.length} most recent` : ''}:`);
    let day = '';
    for (const it of r.items) {
      if (it.day !== day) L.push('', `## ${dayLabel((day = it.day))} (${it.day})`);
      if (it.note) {
        L.push(`- note: ${claude.trimText(it.note, 300)}`);
        continue;
      }
      L.push(`### ${sessionHead(it)}`);
      for (const e of it.hits) L.push(entryLine(e, 300));
      if (it.more) L.push(`- …and ${it.more} more that day`);
    }
    return L.join('\n');
  }
  const list = dayList(live, project);
  const end = parseDay(opts.day) || dayOf(Date.now());
  const span = Math.min(31, Math.max(1, Number(opts.days) || 1));
  for (let i = 0; i < span; i++) {
    const day = shiftDay(end, -i);
    const p = dayPage(day, live, project, list);
    if (!p.sessions.length && !p.note && span > 1) continue;
    const t = p.totals;
    const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    L.push(`# ${dayLabel(day)} (${day})`);
    if (p.sessions.length) L.push(`${n(t.sessions, 'session')} · ${n(t.prompts, 'prompt')} · ${n(t.commits, 'commit')} · ${n(t.prs, 'PR')} · ${clock(t.first)}–${clock(t.last)}`);
    else L.push('Nothing recorded.');
    if (p.note) L.push('', `Note: ${p.note}`);
    for (const s of p.sessions) {
      L.push('', `## ${sessionHead(s)}`);
      const files = s.entries.filter((e) => e.k === 'f');
      const rest = [];
      for (const e of s.entries) {
        if (e.k === 'f' || e.k === 'o') continue;
        const prev = rest[rest.length - 1];
        // steps finished one after another read as one line
        if (e.k === 's' && prev && prev.k === 's') prev.x += ` · ${e.x}`;
        else rest.push({ ...e });
      }
      for (const e of rest.slice(0, 60)) L.push(entryLine(e, e.k === 's' ? 700 : 400));
      if (rest.length > 60) L.push(`- …and ${rest.length - 60} more`);
      if (files.length) L.push(`- files: ${files.slice(0, 12).map((e) => path.basename(e.x)).join(', ')}${files.length > 12 ? ` and ${files.length - 12} more` : ''}`);
      for (const pr of s.prs) L.push(`- PR: ${pr.repo}#${pr.number} ${pr.url}`);
    }
    L.push('');
  }
  return L.join('\n').trim() || `Nothing recorded between ${shiftDay(end, 1 - span)} and ${end}.`;
}

module.exports = {
  sync, crawl, setNotes, page, markdown, refresh, stats, titleOf, rev: () => rev,
  dayOf, parseDay, shiftDay, isDay, commitMessage, DAYS_DIR, REG_FILE, MAX, CAP,
};
