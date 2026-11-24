'use strict';
// Read-only access to Claude's own files:
//   - the desktop app's per-session metadata (title, PRs, parent session, status summary)
//   - its sidebar groups
//   - the CLI transcripts (for each session's step list and last recap)
//   - the registry of running sessions (busy / idle)
// Nothing in here writes outside the board's own cache folder.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const P = require('./paths');
const resources = require('./resources');

const CACHE_V = 4;
// the desktop session index has its own version: it changes when a field is added to a session's record
const DESKTOP_V = 5;

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readdir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

function writeCache(name, data) {
  try {
    fs.mkdirSync(P.CACHE_DIR, { recursive: true });
    const file = path.join(P.CACHE_DIR, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (_) {}
}

// ---------- small derivations ----------

function projectOf(cwd) {
  if (!cwd) return { root: '', name: 'Unknown' };
  if (cwd.includes('/scratch-workspaces/')) return { root: '(no folder)', name: 'No folder' };
  const root = cwd.replace(/\/\.claude\/worktrees\/.*$/, '').replace(/\/\.worktrees\/.*$/, '').replace(/\/+$/, '');
  return { root, name: path.basename(root.trim()) || root || 'No folder' };
}

const NOT_TICKETS = new Set(['PR', 'UTF', 'ISO', 'SHA', 'RFC', 'HTTP', 'GPT', 'COVID', 'ES', 'TLS', 'SSL', 'UTC', 'GMT', 'V']);
/** Tracker keys written the usual way (PROJ-3883) in a piece of text. */
function ticketsIn(...texts) {
  const out = new Set();
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,7})-(\d{2,6})(?![A-Za-z0-9])/g)) {
      if (!NOT_TICKETS.has(m[1])) out.add(`${m[1]}-${m[2]}`);
    }
  }
  return [...out];
}

/**
 * Keys in a branch name, where they are usually lower case (proj-4176/fix).
 * Only prefixes already seen as real keys count, so "review-26397" does not.
 */
function ticketsInBranch(branch, knownPrefixes) {
  const out = [];
  for (const m of String(branch || '').matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,7})-(\d{2,6})(?![A-Za-z0-9])/g)) {
    const prefix = m[1].toUpperCase();
    if (knownPrefixes.has(prefix)) out.push(`${prefix}-${m[2]}`);
  }
  return out;
}

function trimText(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---------- desktop sessions ----------

/**
 * Other project folders a session worked in. A session started in a folder that holds
 * several repos (~/work) lists the repos it ran commands in under shellFolders, and those
 * say more about what it is about than the parent folder does. Scratch folders are left out.
 */
function alsoIn(folders, own) {
  const out = [];
  for (const f of Array.isArray(folders) ? folders : []) {
    if (typeof f !== 'string' || /^\/(private\/)?(tmp|var\/folders)\//.test(f)) continue;
    const name = projectOf(f).name;
    if (name && name !== own && name !== 'No folder' && name !== 'Unknown' && !out.includes(name)) out.push(name);
  }
  return out;
}

function slimDesktop(d) {
  const proj = projectOf(d.cwd || d.originCwd);
  const pts = d.postTurnSummary || null;
  const prs = [];
  for (const p of Array.isArray(d.prs) ? d.prs : []) {
    if (p && p.prNumber) prs.push({ number: p.prNumber, repo: p.repo || '', url: p.url || '', state: p.state || '', branch: p.branch || '' });
  }
  if (!prs.length && d.prNumber) {
    prs.push({ number: d.prNumber, repo: d.prRepository || '', url: d.prUrl || '', state: d.prState || '', branch: d.branch || '' });
  }
  const title = trimText(d.title, 160) || 'Untitled session';
  return {
    id: d.sessionId,
    cliId: d.cliSessionId || null,
    source: 'desktop',
    title,
    cwd: d.cwd || d.originCwd || '',
    project: proj.root,
    projectName: proj.name,
    alsoIn: alsoIn(d.shellFolders, proj.name),
    createdAt: Number(d.createdAt) || 0,
    lastActivityAt: Number(d.lastActivityAt) || Number(d.createdAt) || 0,
    archived: !!d.isArchived,
    starred: !!d.isStarred,
    model: d.model || '',
    branch: d.branch || '',
    worktree: d.worktreeName || '',
    prs,
    parentId: (d.spawnedFrom && d.spawnedFrom.sessionId) || null,
    forkedFrom: d.forkedFromSessionId || null,
    routineId: d.scheduledTaskId || null,
    summary: pts
      ? { category: pts.status_category || '', detail: trimText(pts.status_detail, 300), needsAction: trimText(pts.needs_action, 400), uuid: pts.summarizes_uuid || '' }
      : null,
    wrapUp: trimText(d.turnWrapUp && d.turnWrapUp.description, 500),
    lastReport: trimText(d.lastTurnReport, 700),
    artifacts: (Array.isArray(d.publishedArtifacts) ? d.publishedArtifacts : [])
      .filter((a) => a && a.url)
      .slice(-6)
      .map((a) => ({ url: a.url, title: trimText(a.title, 100) })),
    turns: Number(d.completedTurns) || 0,
    error: trimText(d.error, 200),
    tickets: ticketsIn(d.title),
    priorCliIds: Array.isArray(d.priorCliSessionIds) ? d.priorCliSessionIds.filter((x) => typeof x === 'string') : [],
    link: `claude://claude.ai/epitaxy/${d.sessionId}`,
  };
}

let desktopCache = null; // file -> { m, s, rec }
let desktopCacheDirty = false;

function loadDesktopCache() {
  if (desktopCache) return;
  const saved = readJSON(path.join(P.CACHE_DIR, 'desktop-index.json'));
  desktopCache = saved && saved.v === DESKTOP_V && saved.files ? saved.files : {};
}

function scanDesktopSessions() {
  loadDesktopCache();
  const seen = new Set();
  const out = [];
  for (const acct of readdir(P.DESKTOP_SESSIONS_DIR)) {
    for (const org of readdir(path.join(P.DESKTOP_SESSIONS_DIR, acct))) {
      const dir = path.join(P.DESKTOP_SESSIONS_DIR, acct, org);
      for (const f of readdir(dir)) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        const file = path.join(dir, f);
        let st;
        try {
          st = fs.statSync(file);
        } catch (_) {
          continue;
        }
        seen.add(file);
        const hit = desktopCache[file];
        if (hit && hit.m === st.mtimeMs && hit.s === st.size) {
          if (hit.rec) out.push(hit.rec);
          continue;
        }
        const d = readJSON(file);
        // The app rewrites these files in place; a half-written one parses as
        // null. Keep the previous record rather than dropping the session.
        if (!d || !d.sessionId) {
          if (hit && hit.rec) out.push(hit.rec);
          continue;
        }
        const rec = slimDesktop(d);
        desktopCache[file] = { m: st.mtimeMs, s: st.size, rec };
        desktopCacheDirty = true;
        out.push(rec);
      }
    }
  }
  for (const file of Object.keys(desktopCache)) {
    if (!seen.has(file)) {
      delete desktopCache[file];
      desktopCacheDirty = true;
    }
  }
  if (desktopCacheDirty) {
    writeCache('desktop-index.json', { v: DESKTOP_V, files: desktopCache });
    desktopCacheDirty = false;
  }
  return out;
}

// ---------- sidebar groups ----------

function readSidebarGroups() {
  const cfg = readJSON(P.DESKTOP_CONFIG);
  const groups = [];
  const assignments = {};
  const scopes = cfg && cfg.preferences && cfg.preferences.epitaxyPrefs && cfg.preferences.epitaxyPrefs['dframe-group-scopes'];
  // Scopes are keyed by account and organisation ("<account>/<org>" today);
  // accept one level of nesting either way rather than depend on the key shape.
  const visit = (scope, depth) => {
    if (!scope || typeof scope !== 'object') return;
    if (Array.isArray(scope.groups) || (scope.assignments && typeof scope.assignments === 'object')) {
      for (const g of Array.isArray(scope.groups) ? scope.groups : []) {
        if (g && g.id && !groups.some((x) => x.id === g.id)) groups.push({ id: g.id, name: trimText(g.name, 80) || 'Group' });
      }
      for (const [k, v] of Object.entries(scope.assignments || {})) {
        if (typeof v === 'string') assignments[k.replace(/^code:/, '')] = v;
      }
    } else if (depth < 2) {
      for (const child of Object.values(scope)) visit(child, depth + 1);
    }
  };
  visit(scopes, 0);
  return { groups, assignments };
}

// ---------- running sessions ----------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Sessions with a live process, keyed by both desktop id and CLI id. */
function readLive() {
  const live = {};
  for (const f of readdir(P.LIVE_DIR)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const d = readJSON(path.join(P.LIVE_DIR, f));
    if (!d || !d.pid || !pidAlive(d.pid)) continue;
    const rec = { pid: d.pid, status: d.status || 'idle', cliId: d.sessionId || null, hostId: d.hostSessionId || null, cwd: d.cwd || '', name: d.name || '' };
    if (rec.hostId) live[rec.hostId] = rec;
    if (rec.cliId) live[rec.cliId] = rec;
  }
  return live;
}

/** The session that owns this process (used by the MCP server and the CLI). */
function currentSession() {
  const { execFileSync } = require('child_process');
  let pid = process.ppid;
  for (let hop = 0; hop < 8 && pid > 1; hop++) {
    const d = readJSON(path.join(P.LIVE_DIR, `${pid}.json`));
    if (d && d.sessionId) return { id: d.hostSessionId || d.sessionId, cliId: d.sessionId, title: d.name || '', cwd: d.cwd || '' };
    try {
      pid = parseInt(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10);
    } catch (_) {
      break;
    }
    if (!pid) break;
  }
  return null;
}

// ---------- transcripts ----------

let transcriptIndex = null;
let transcriptIndexAt = 0;

/** cliId -> transcript path. Rebuilt at most every 30s. */
function indexTranscripts(force) {
  if (transcriptIndex && !force && Date.now() - transcriptIndexAt < 30000) return transcriptIndex;
  const idx = {};
  for (const proj of readdir(P.PROJECTS_DIR)) {
    const dir = path.join(P.PROJECTS_DIR, proj);
    for (const f of readdir(dir)) {
      if (f.endsWith('.jsonl')) idx[f.slice(0, -6)] = path.join(dir, f);
    }
  }
  transcriptIndex = idx;
  transcriptIndexAt = Date.now();
  return idx;
}

function freshDetail() {
  return {
    v: CACHE_V, size: 0, mtimeMs: 0, offset: 0,
    plan: [], planAt: 0, seen: [],
    wrap: null, firstPrompt: '', lastPrompt: '', title: '', cost: 0, cwd: '', startedAt: 0, lastAt: 0,
  };
}

/** Replay one step-list tool call onto the running list. */
function applyPlanCall(d, name, input, at) {
  if (!input || typeof input !== 'object') return;
  if (name.endsWith('update_plan')) {
    if (Array.isArray(input.items)) {
      d.plan = input.items
        .filter((i) => i && i.content)
        .map((i) => ({ content: trimText(i.content, 200), status: i.status === 'completed' || i.status === 'in_progress' ? i.status : 'pending' }));
    }
    if (input.advance) {
      const cur = d.plan.find((i) => i.status === 'in_progress');
      if (cur) cur.status = 'completed';
      const next = d.plan.find((i) => i.status === 'pending');
      if (next) next.status = 'in_progress';
    }
    if (Array.isArray(input.done)) for (const n of input.done) if (d.plan[n - 1]) d.plan[n - 1].status = 'completed';
    if (typeof input.start === 'number' && d.plan[input.start - 1]) d.plan[input.start - 1].status = 'in_progress';
    d.planAt = at;
  } else if (name.endsWith('wrap_up')) {
    for (const i of d.plan) if (i.status === 'in_progress') i.status = 'completed';
    d.wrap = { recap: trimText(input.recap, 600), ask: trimText(input.ask, 200), at };
  } else if (name === 'TodoWrite') {
    if (Array.isArray(input.todos)) {
      d.plan = input.todos
        .filter((i) => i && i.content)
        .map((i) => ({ content: trimText(i.content, 200), status: i.status === 'completed' || i.status === 'in_progress' ? i.status : 'pending' }));
      d.planAt = at;
    }
  } else if (name === 'TaskCreate') {
    const subject = trimText(input.subject || input.description, 200);
    if (subject) d.plan.push({ content: subject, status: 'pending', taskId: String(d.plan.filter((i) => i.taskId).length + 1) });
    d.planAt = at;
  } else if (name === 'TaskUpdate') {
    const item = d.plan.find((i) => i.taskId && i.taskId === String(input.taskId));
    if (item && input.status) {
      if (input.status === 'deleted') d.plan = d.plan.filter((i) => i !== item);
      else item.status = input.status === 'completed' || input.status === 'in_progress' ? input.status : 'pending';
    }
    d.planAt = at;
  }
}

const PLAN_TOOLS = /^(mcp__ccd_turn__update_plan|mcp__ccd_turn__wrap_up|TodoWrite|TaskCreate|TaskUpdate)$/;

/** The user's own words in a prompt, without the blocks the app injects around them. */
function cleanPrompt(text) {
  let t = String(text || '').trim();
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
    return `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  for (let i = 0; i < 20; i++) {
    const m = /^<([a-zA-Z][\w-]*)[^>]*>[\s\S]*?<\/\1>\s*/.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return t.startsWith('<') ? '' : t;
}

function userText(o) {
  const c = o.message && o.message.content;
  if (typeof c === 'string') return cleanPrompt(c);
  if (!Array.isArray(c)) return '';
  for (const b of c) {
    const t = b && b.type === 'text' && b.text ? cleanPrompt(b.text) : '';
    if (t) return t;
  }
  return '';
}

function handleLine(buf, d) {
  if (buf.length < 30) return;
  const head = buf.subarray(0, 48);
  // Request logs repeat every tool definition; they are never what we want.
  if (head.includes('"type":"api-request')) return;
  let o = null;
  const planTool =
    buf.includes('"tool_use"') &&
    (buf.includes('update_plan') || buf.includes('wrap_up') || buf.includes('"TodoWrite"') || buf.includes('"TaskCreate"') || buf.includes('"TaskUpdate"'));
  try {
    if (planTool) o = JSON.parse(buf.toString('utf8'));
    else if (buf.length < 30000 && (head.includes('"type":"last-prompt"') || head.includes('"type":"cost-state"') || head.includes('-title"'))) {
      o = JSON.parse(buf.toString('utf8'));
    } else if (!d.firstPrompt && (d.tries || 0) < 60 && buf.length < 400000 && buf.includes('"type":"user"')) {
      d.tries = (d.tries || 0) + 1; // some sessions never have a plain-text prompt
      o = JSON.parse(buf.toString('utf8'));
    }
  } catch (_) {
    return;
  }
  if (!o || o.isSidechain) return;
  const at = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
  if (at) {
    if (!d.startedAt) d.startedAt = at;
    d.lastAt = at;
  }
  switch (o.type) {
    case 'assistant': {
      const content = o.message && o.message.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || !PLAN_TOOLS.test(b.name || '')) continue;
        // The same tool call can be logged more than once while streaming.
        if (b.id) {
          if (d.seen.includes(b.id)) continue;
          d.seen.push(b.id);
          if (d.seen.length > 60) d.seen.shift();
        }
        applyPlanCall(d, b.name, b.input, at);
      }
      return;
    }
    case 'user': {
      if (!d.cwd && o.cwd) d.cwd = o.cwd;
      if (!d.firstPrompt) {
        const t = userText(o);
        if (t) d.firstPrompt = trimText(t, 500);
      }
      return;
    }
    case 'last-prompt':
      if (o.lastPrompt) d.lastPrompt = trimText(o.lastPrompt, 500);
      return;
    case 'custom-title':
      if (o.customTitle) d.title = trimText(o.customTitle, 160);
      return;
    case 'ai-title':
      if (o.aiTitle && !d.title) d.title = trimText(o.aiTitle, 160);
      return;
    case 'cost-state':
      if (typeof o.totalCostUSD === 'number') d.cost = Math.round(o.totalCostUSD * 100) / 100;
      return;
    default:
  }
}

const detailMem = new Map(); // cliId -> detail

function detailFile(cliId) {
  return path.join(P.CACHE_DIR, 'transcripts', `${cliId}.json`);
}

function cachedDetail(cliId) {
  if (!cliId) return null;
  if (detailMem.has(cliId)) return detailMem.get(cliId);
  const d = readJSON(detailFile(cliId));
  if (d && d.v === CACHE_V) {
    detailMem.set(cliId, d);
    return d;
  }
  return null;
}

/** True when the transcript has grown since it was last read. */
function detailIsStale(cliId) {
  const file = indexTranscripts()[cliId];
  if (!file) return false;
  const d = cachedDetail(cliId);
  if (!d) return true;
  try {
    const st = fs.statSync(file);
    return st.size !== d.size || st.mtimeMs !== d.mtimeMs || d.linksV !== resources.VERSION;
  } catch (_) {
    return false;
  }
}

/**
 * Hand every complete line of `file` between byte `from` and byte `size` to
 * `onLine` (as a Buffer). Returns where the next read should start: an
 * unfinished last line is left for next time.
 */
async function readLines(file, from, size, onLine) {
  const fh = await fsp.open(file, 'r');
  let offset = from;
  try {
    const CHUNK = 1 << 20;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = from;
    let parts = [];
    let partsLen = 0;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        if (nl === -1) break;
        let line = chunk.subarray(start, nl);
        if (parts.length) {
          parts.push(Buffer.from(line));
          line = Buffer.concat(parts);
          parts = [];
          partsLen = 0;
        }
        onLine(line);
        start = nl + 1;
      }
      if (start < bytesRead) {
        parts.push(Buffer.from(chunk.subarray(start)));
        partsLen += bytesRead - start;
      }
      pos += bytesRead;
      offset = pos - partsLen;
    }
  } finally {
    await fh.close();
  }
  return offset;
}

/**
 * Read a transcript for its step list, last recap and prompts. Transcripts are
 * append-only and can be hundreds of MB, so this continues from where the
 * previous read stopped and only decodes the few lines that matter.
 */
function scanTranscript(cliId) {
  // one read at a time per transcript: two would both continue from the same place
  if (reading.has(cliId)) return reading.get(cliId);
  const run = readTranscript(cliId).finally(() => reading.delete(cliId));
  reading.set(cliId, run);
  return run;
}

const reading = new Map();

async function readTranscript(cliId) {
  const file = indexTranscripts()[cliId];
  if (!file) return cachedDetail(cliId);
  let st;
  try {
    st = await fsp.stat(file);
  } catch (_) {
    return cachedDetail(cliId);
  }
  let d = cachedDetail(cliId);
  if (d && d.size === st.size && d.mtimeMs === st.mtimeMs && d.linksV === resources.VERSION) return d;
  if (!d || d.offset > st.size) d = freshDetail();
  if (d.linksV !== resources.VERSION) {
    // read before links were collected: go over the part already read, once
    const links = resources.fresh();
    await readLines(file, 0, d.offset, (line) => resources.readLine(line, links));
    d.links = links;
    d.linksV = resources.VERSION;
  }
  d.offset = await readLines(file, d.offset, st.size, (line) => {
    handleLine(line, d);
    resources.readLine(line, d.links);
  });
  d.size = st.size;
  d.mtimeMs = st.mtimeMs;
  detailMem.set(cliId, d);
  try {
    fs.mkdirSync(path.join(P.CACHE_DIR, 'transcripts'), { recursive: true });
    fs.writeFileSync(detailFile(cliId), JSON.stringify(d));
  } catch (_) {}
  return d;
}

// ---------- everything together ----------

function stateOf(s, live) {
  if (live && live.status && live.status !== 'idle') return 'running';
  const cat = s.summary && s.summary.category;
  if (cat === 'blocked') return 'needs_you';
  if (cat === 'review_ready') return 'review';
  if (cat === 'completed') return 'done';
  return 'idle';
}

/**
 * One pass over Claude's files. Cheap after the first call: unchanged session
 * files are served from the cache, so this is a few hundred stat calls.
 */
function scan() {
  // copies, so the per-scan fields added below never leak into the cache
  const sessions = scanDesktopSessions().map((s) => ({ ...s }));
  const known = new Set(sessions.map((s) => s.cliId).filter(Boolean));
  for (const s of sessions) for (const id of s.priorCliIds || []) known.add(id); // earlier halves of a resumed session
  const transcripts = indexTranscripts(true);
  const live = readLive();
  const { groups, assignments } = readSidebarGroups();

  // Sessions run from a terminal have a transcript but no desktop record.
  for (const [cliId, file] of Object.entries(transcripts)) {
    if (known.has(cliId)) continue;
    let st;
    try {
      st = fs.statSync(file);
    } catch (_) {
      continue;
    }
    const d = cachedDetail(cliId);
    const cwd = (d && d.cwd) || (live[cliId] && live[cliId].cwd) || '';
    const proj = projectOf(cwd);
    const title = (d && (cleanPrompt(d.title) || d.firstPrompt)) || (live[cliId] && live[cliId].name) || 'Terminal session';
    sessions.push({
      id: cliId, cliId, source: 'cli', title: trimText(title, 160), cwd, project: proj.root, projectName: proj.name, alsoIn: [],
      createdAt: Math.round((d && d.startedAt) || st.birthtimeMs || st.mtimeMs), lastActivityAt: Math.round(st.mtimeMs),
      archived: false, starred: false, model: '', branch: '', worktree: '', prs: [], parentId: null, forkedFrom: null, routineId: null,
      summary: null, wrapUp: '', lastReport: '', artifacts: [], turns: 0, error: '', tickets: ticketsIn(title), link: '',
    });
  }

  const prefixes = new Set();
  for (const s of sessions) for (const t of s.tickets) prefixes.add(t.slice(0, t.lastIndexOf('-')));
  for (const s of sessions) {
    if (s.branch) s.tickets = [...new Set([...s.tickets, ...ticketsInBranch(s.branch, prefixes)])];
  }

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const slack = resources.slackDirectory(sessions.flatMap((s) => [s.cliId, ...(s.priorCliIds || [])]).map(cachedDetail));
  for (const s of sessions) {
    const l = live[s.id] || (s.cliId && live[s.cliId]) || null;
    s.live = l ? l.status : '';
    s.state = stateOf(s, l);
    s.groupId = assignments[s.id] || null;
    s.hasTranscript = !!(s.cliId && transcripts[s.cliId]);
    if (s.parentId && !byId.has(s.parentId)) s.parentId = null;
    if (s.forkedFrom && !byId.has(s.forkedFrom)) s.forkedFrom = null;
    const d = cachedDetail(s.cliId);
    if (d) {
      const total = d.plan.length;
      s.steps = total
        ? { total, done: d.plan.filter((i) => i.status === 'completed').length, current: (d.plan.find((i) => i.status === 'in_progress') || {}).content || '' }
        : null;
      s.cost = d.cost || 0;
      if (!s.wrapUp && d.wrap) s.wrapUp = d.wrap.recap;
      // "Start a session" on a card opens Claude with a brief that names the card
      const brief = /^Work on Taskboard card ([A-Za-z][A-Za-z0-9]*-\d+)\b/.exec(d.firstPrompt || '');
      if (brief) s.briefCard = brief[1].toUpperCase();
    } else {
      s.steps = null;
      s.cost = 0;
    }
    s.resources = resources.forSession(s, [d, ...(s.priorCliIds || []).map(cachedDetail)], slack);
  }
  return { sessions, groups, scannedAt: Date.now() };
}

/** Full detail for one session: step list, recap, prompts. */
async function sessionDetail(session) {
  const d = session.cliId ? await scanTranscript(session.cliId) : null;
  return {
    plan: d ? d.plan.map((i) => ({ content: i.content, status: i.status })) : [],
    planAt: d ? d.planAt : 0,
    wrap: d ? d.wrap : null,
    firstPrompt: d ? d.firstPrompt : '',
    lastPrompt: d ? d.lastPrompt : '',
    cost: d ? d.cost : 0,
    hasTranscript: !!(session.cliId && indexTranscripts()[session.cliId]),
  };
}

module.exports = {
  scan, sessionDetail, scanTranscript, detailIsStale, cachedDetail, currentSession, readLive, readSidebarGroups,
  projectOf, ticketsIn, ticketsInBranch, cleanPrompt, trimText, applyPlanCall, freshDetail, handleLine, stateOf,
  indexTranscripts, readLines,
};
