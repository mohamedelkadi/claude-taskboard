'use strict';
// The board's web server. Local only: it listens on 127.0.0.1, refuses
// requests addressed to any other host name, and accepts changes only as
// same-origin JSON, because what it serves is private session history.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const P = require('./paths');
const store = require('./store');
const claude = require('./claude');
const view = require('./view');
const diary = require('./diary');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const ALLOWED_HOSTS = new Set([`127.0.0.1:${P.PORT}`, `localhost:${P.PORT}`]);

let scanResult = { sessions: [], groups: [], scannedAt: 0 };
let state = null;
let stateJson = '{}';
let stateHash = '';
let version = 0;
let lastError = '';
let announced = '';
const clients = new Set();

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

/** Open a file, folder or link with the system. Switched off in tests. */
function launch(target) {
  if (process.env.TASKBOARD_NO_OPEN) return;
  execFile('open', [target], () => {});
}

/** The few numbers and names the Mac app's menu-bar item and Dock badge show. */
function summary() {
  const st = state || { sessions: [], routines: [], cards: [] };
  const latestRun = new Set(st.routines.map((r) => r.latestId));
  const cardKey = new Map(st.cards.map((c) => [c.id, c.key]));
  const visible = st.sessions.filter((s) => !s.archived && (!s.routineId || latestRun.has(s.id)));
  const recent = (a, b) => b.lastActivityAt - a.lastActivityAt;
  const row = (s) => ({ id: s.id, title: s.title, card: cardKey.get(s.cardId) || '', ask: (s.summary && s.summary.needsAction) || '' });
  return {
    needs: visible.filter((s) => s.estate === 'needs_you').sort(recent).map(row),
    running: visible.filter((s) => s.estate === 'running').sort(recent).map(row),
    review: visible.filter((s) => s.estate === 'review').length,
    unsorted: visible.filter((s) => !s.cardId && !s.hidden).length,
  };
}

/** What open pages compare against what they have: the board's version and the diary's. */
const versions = () => JSON.stringify({ version, diary: diary.rev() });

/** Tell open pages that the board or the diary changed. Says nothing when neither did. */
function announce() {
  const now = versions();
  if (now === announced) return;
  announced = now;
  for (const res of clients) res.write(`data: ${now}\n\n`);
}

/** Recompute what the UI shows; tell open pages only if something changed. */
function rebuild() {
  const board = store.load();
  const next = view.buildState(board, scanResult);
  const { generatedAt, scannedAt, ...stable } = next;
  const hash = crypto.createHash('md5').update(JSON.stringify(stable)).digest('hex');
  const changed = hash !== stateHash || !state;
  if (changed) {
    stateHash = hash;
    version += 1;
    next.version = version;
    state = next;
    stateJson = JSON.stringify(next);
    view.exportMarkdown(next);
  } else {
    state.generatedAt = generatedAt;
    state.scannedAt = scannedAt;
  }
  // the diary remembers each session's title, project and card for when Claude no longer has it
  diary.setNotes(board.dayNotes);
  diary.sync(state);
  announce();
  return changed;
}

function rescan() {
  try {
    scanResult = claude.scan();
    if (!store.exists()) {
      const made = view.seed(scanResult);
      if (made) log('first run: imported', JSON.stringify(made));
    }
    const linked = view.applyAutoLinks(scanResult);
    if (linked) log('auto-linked', linked, 'sessions');
    rebuild();
    lastError = '';
    crawl();
    diary.crawl(announce).catch((e) => log('diary:', e.message));
  } catch (e) {
    lastError = e.message;
    log('scan failed:', e.message);
  }
}

// Read the transcripts of sessions that matter (on a card, or not archived)
// in the background, newest first, so step lists appear without blocking.
let crawling = false;
async function crawl() {
  if (crawling) return;
  crawling = true;
  try {
    const want = scanResult.sessions
      .filter((s) => s.cliId && (s.cardId || !s.archived))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    let read = 0;
    for (const s of want) {
      if (!claude.detailIsStale(s.cliId)) continue;
      try {
        await claude.scanTranscript(s.cliId);
        read++;
      } catch (e) {
        log('transcript', s.cliId, e.message);
      }
      if (read && read % 20 === 0) {
        scanResult = claude.scan();
        rebuild();
      }
    }
    if (read) {
      scanResult = claude.scan();
      rebuild();
    }
  } finally {
    crawling = false;
  }
}

let timer = null;
let lastScan = 0;
function scheduleScan() {
  if (timer) return;
  const wait = Math.max(700, 1500 - (Date.now() - lastScan));
  timer = setTimeout(() => {
    timer = null;
    lastScan = Date.now();
    rescan();
  }, wait);
}

function watch(target, opts, filter) {
  try {
    fs.watch(target, opts, (_ev, file) => {
      if (!filter || filter(file)) scheduleScan();
    }).on('error', () => {});
  } catch (_) {}
}

// ---------- HTTP ----------

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new store.UserError('Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        reject(new store.UserError('Bad JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !TYPES[path.extname(file)]) return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(file)]);
  });
}

async function handle(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 403, 'Forbidden', 'text/plain');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET') {
    if (p === '/api/health') return json(res, 200, { app: 'taskboard', pid: process.pid, version, sessions: scanResult.sessions.length, error: lastError });
    if (p === '/api/state') return send(res, 200, stateJson);
    if (p === '/api/summary') return json(res, 200, summary());
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${versions()}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/session') {
      const s = scanResult.sessions.find((x) => x.id === url.searchParams.get('id'));
      if (!s) return json(res, 404, { ok: false, error: 'No such session.' });
      return json(res, 200, { ok: true, session: s, detail: await claude.sessionDetail(s) });
    }
    if (p === '/api/diary') {
      if (!state) return json(res, 503, { ok: false, error: 'The board is still starting.' });
      const arg = (name, max) => (url.searchParams.get(name) || '').slice(0, max);
      return json(res, 200, diary.page({ day: arg('day', 10), q: arg('q', 200), project: arg('project', 200) }, state));
    }
    if (p === '/api/export') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="taskboard-board.json"' });
      return res.end(JSON.stringify(store.load(), null, 1));
    }
    if (p.startsWith('/api/')) return json(res, 404, { ok: false, error: 'Not found.' });
    return serveStatic(res, p);
  }

  if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
  // A page on another site cannot send JSON here without a preflight we never answer.
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, 'Forbidden', 'text/plain');
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, 'JSON only', 'text/plain');

  try {
    const body = await readBody(req);
    if (p === '/api/op') {
      const result = store.apply(body.name, body.args);
      rebuild();
      return send(res, 200, `{"ok":true,"result":${JSON.stringify(result === undefined ? null : result)},"state":${stateJson}}`);
    }
    if (p === '/api/rescan') {
      rescan();
      return send(res, 200, `{"ok":true,"state":${stateJson}}`);
    }
    if (p === '/api/open') {
      // Only ever a session link built here; never a URL from the request.
      const s = scanResult.sessions.find((x) => x.id === body.sessionId);
      if (!s || !/^local_[0-9a-f-]{36}$/.test(s.id)) throw new store.UserError('That session cannot be opened in the Claude app.');
      launch(`claude://claude.ai/epitaxy/${s.id}`);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/new-session') {
      // Opens Claude's new-session page in the card's project folder, with the
      // card's brief in the prompt box. Claude never sends it: the user does.
      const card = store.findCard(store.load(), body.card);
      const shown = state && state.cards.find((c) => c.id === card.id);
      const folder = (shown && shown.view.folder) || '';
      const brief = view.sessionBrief(card, folder);
      if (!body.copyOnly) launch(view.newSessionUrl(brief, folder));
      return json(res, 200, { ok: true, brief, folder });
    }
    if (p === '/api/reveal') {
      launch(P.DATA_DIR);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: 'Not found.' });
  } catch (e) {
    if (e instanceof store.UserError) return json(res, 400, { ok: false, error: e.message });
    log('request failed:', e.stack || e.message);
    return json(res, 500, { ok: false, error: e.message });
  }
}

function main() {
  fs.mkdirSync(P.DATA_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('unhandled:', e.stack || e.message);
      try {
        json(res, 500, { ok: false, error: 'Server error.' });
      } catch (_) {}
    });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`port ${P.PORT} is already in use; another board is probably running. Exiting.`);
      process.exit(0);
    }
    throw e;
  });
  server.listen(P.PORT, P.HOST, () => {
    fs.writeFileSync(P.PID_FILE, String(process.pid));
    log(`taskboard listening on ${P.boardUrl()} (pid ${process.pid})`);
    rescan();
    watch(P.DESKTOP_SESSIONS_DIR, { recursive: true });
    watch(P.LIVE_DIR, {});
    watch(P.DESKTOP_DIR, {}, (f) => f === path.basename(P.DESKTOP_CONFIG));
    watch(P.DATA_DIR, {}, (f) => f === path.basename(P.BOARD_FILE));
    // Safety net for anything the watchers miss (and for busy/idle flips).
    setInterval(scheduleScan, 20000).unref();
    setInterval(() => {
      for (const res of clients) res.write(': ping\n\n');
    }, 25000).unref();
  });
  const bye = () => {
    try {
      if (fs.readFileSync(P.PID_FILE, 'utf8') === String(process.pid)) fs.unlinkSync(P.PID_FILE);
    } catch (_) {}
    process.exit(0);
  };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

if (require.main === module) main();
module.exports = { main };
