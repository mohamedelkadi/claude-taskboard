'use strict';
// Workflows: a saved prompt on a card that the board runs on its own with
// `claude -p`, by hand or on a schedule. A run uses the Claude login stored on
// this Mac (the subscription), never an API key, so nothing has to be set up.
//
// The board file holds each workflow and its last runs; the raw stream of a run
// is kept next to it in runs/<id>.jsonl for the log view. Only the web server
// runs workflows: the MCP server and the CLI ask it to.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFile } = require('child_process');
const P = require('./paths');
const store = require('./store');

const ACCESS = {
  // what the run may do without anyone there to approve it
  read: { label: 'Read and report', mode: 'dontAsk' },
  edit: { label: 'Edit files', mode: 'acceptEdits' },
  full: { label: 'Anything', mode: 'bypassPermissions' },
};
const SCHEDULES = ['manual', 'hourly', 'daily', 'weekdays', 'weekly'];
const MODELS = ['', 'opus', 'sonnet', 'haiku'];
const MAX_PARALLEL = 3;
const BOARD_READ = ['mcp__taskboard__board_get_card', 'mcp__taskboard__board_overview', 'mcp__taskboard__board_find_sessions'];
const DENIED = /^Permission to use (\S+) has been denied/;
const RUNS_KEPT = 10; // per workflow
const LOG_MAX = 5 * 1024 * 1024;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

const rid = () => crypto.randomBytes(4).toString('hex');
const running = new Map(); // run id -> { child, cardId, workflowId, stop, timer }
let logFn = () => {};

// ---------- finding Claude ----------

function findClaude() {
  if (process.env.TASKBOARD_CLAUDE_BIN) return process.env.TASKBOARD_CLAUDE_BIN; // the tests' fake
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const r = spawnSync('which', ['claude'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The environment a run gets: the server's own, minus what would make it act as part of
 * the Claude session that happened to start the server, and minus an API key, so it runs
 * on the subscription login like the user asked for.
 */
function runEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'ANTHROPIC_API_KEY' || (/^CLAUDE_/.test(k) && k !== 'CLAUDE_CODE_OAUTH_TOKEN' && k !== 'CLAUDE_CONFIG_DIR')) delete env[k];
  }
  const extra = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  env.PATH = [...new Set([...(env.PATH || '').split(':').filter(Boolean), ...extra])].join(':');
  return env;
}

let authCache = null;
/** Whether Claude is installed and logged in, and until when. Asked of `claude auth status`, at most once a minute. */
function check() {
  if (authCache && Date.now() - authCache.at < 60e3) return Promise.resolve(authCache.value);
  const bin = findClaude();
  if (!bin) return Promise.resolve({ claude: false, loggedIn: false });
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status'], { env: runEnv(), timeout: 15000 }, (err, stdout) => {
      let a = {};
      try {
        a = JSON.parse(stdout);
      } catch (_) {}
      const value = {
        claude: true,
        loggedIn: !!a.loggedIn,
        method: a.authMethod || '',
        plan: a.subscriptionType || '',
        apiKey: /api.?key/i.test(a.authMethod || ''),
        expiresAt: a.loginExpiresAt ? Date.parse(a.loginExpiresAt) || 0 : 0,
        error: err && !stdout ? 'Could not ask Claude whether it is logged in.' : '',
      };
      authCache = { at: Date.now(), value };
      resolve(value);
    });
  });
}

// ---------- workflows on the board ----------

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function sanitizeSchedule(s) {
  const kind = s && SCHEDULES.includes(s.kind) ? s.kind : 'manual';
  const out = { kind };
  if (kind === 'hourly') out.every = Math.min(24, Math.max(1, Math.round(Number(s.every) || 1)));
  if (kind === 'daily' || kind === 'weekdays' || kind === 'weekly') {
    if (!HHMM.test(String(s.at || ''))) throw new store.UserError('Give the time as HH:MM, for example 09:00.');
    out.at = s.at;
  }
  if (kind === 'weekly') out.day = Math.min(6, Math.max(0, Math.round(Number(s.day) || 0)));
  return out;
}

/** Create or change a workflow on a card. */
function save(b, a) {
  const card = store.findCard(b, a.card);
  if (!Array.isArray(card.workflows)) card.workflows = [];
  const w = a.workflow || {};
  const name = clean(w.name, 80);
  const prompt = String(w.prompt == null ? '' : w.prompt).trim().slice(0, 20000);
  if (!name) throw new store.UserError('Give the workflow a name.');
  if (!prompt) throw new store.UserError('Say what Claude should do.');
  const access = ACCESS[w.access] ? w.access : 'read';
  const folder = String(w.folder || '').trim().replace(/^~(?=\/|$)/, os.homedir());
  if (folder && !path.isAbsolute(folder)) throw new store.UserError('The folder must be a full path, like ~/work/app.');
  const schedule = sanitizeSchedule(w.schedule);
  const t = Date.now();
  let wf = w.id ? card.workflows.find((x) => x.id === w.id) : null;
  if (w.id && !wf) throw new store.UserError('That workflow is gone. It may have been deleted.');
  if (!wf) card.workflows.push((wf = { id: 'w_' + rid(), createdAt: t, enabled: true }));
  const scheduleChanged = JSON.stringify(wf.schedule) !== JSON.stringify(schedule);
  Object.assign(wf, {
    name, prompt, folder, access, schedule,
    model: MODELS.includes(w.model) ? w.model : '',
    timeoutMin: Math.min(240, Math.max(1, Math.round(Number(w.timeoutMin) || 30))),
    postNote: w.postNote !== false,
    updatedAt: t,
  });
  // a new or changed schedule counts from now: it never fires for times already past
  if (scheduleChanged) wf.scheduleFrom = t;
  if (w.enabled !== undefined) wf.enabled = !!w.enabled;
  card.updatedAt = t;
  return wf;
}

function findWorkflow(card, ref) {
  const list = card.workflows || [];
  const r = String(ref == null ? '' : ref).trim();
  const low = r.toLowerCase();
  const hit = list.find((w) => w.id === r) || list.find((w) => w.name.toLowerCase() === low);
  if (hit) return hit;
  const some = list.filter((w) => w.name.toLowerCase().includes(low));
  if (r && some.length === 1) return some[0];
  if (!r && list.length === 1) return list[0];
  throw new store.UserError(list.length ? `No workflow "${r}" on ${card.key}. Workflows: ${list.map((w) => w.name).join(', ')}.` : `${card.key} has no workflows.`);
}

// the operations a page, a Claude session or the CLI may apply
Object.assign(store.OPS, {
  'workflow.save': save,
  'workflow.remove'(b, a) {
    const card = store.findCard(b, a.card);
    const wf = findWorkflow(card, a.workflow);
    if ((card.runs || []).some((r) => r.workflowId === wf.id && r.status === 'running')) throw new store.UserError('It is running. Stop it first.');
    card.workflows = card.workflows.filter((w) => w.id !== wf.id);
    for (const r of (card.runs || []).filter((x) => x.workflowId === wf.id)) removeLog(r.id);
    card.runs = (card.runs || []).filter((r) => r.workflowId !== wf.id);
    card.updatedAt = Date.now();
    return { removed: wf.id };
  },
  'workflow.enable'(b, a) {
    const card = store.findCard(b, a.card);
    const wf = findWorkflow(card, a.workflow);
    wf.enabled = !!a.enabled;
    if (wf.enabled) wf.scheduleFrom = Date.now(); // a paused schedule picks up from now, not with every missed run
    card.updatedAt = Date.now();
    return wf;
  },
});

// ---------- schedules ----------

/** The local time `hhmm` on the day of `ms`. */
function atTime(ms, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(ms);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * When a workflow is next due, or 0 when it only runs by hand. Counted from the last time
 * the schedule fired (or from when it was set), so a Mac that slept through a run does it
 * once on waking, not once per missed time.
 */
function nextRun(wf) {
  const s = wf.schedule || { kind: 'manual' };
  if (!wf.enabled || s.kind === 'manual') return 0;
  const from = Math.max(wf.lastScheduledAt || 0, wf.scheduleFrom || wf.createdAt || 0);
  if (s.kind === 'hourly') return from + s.every * HOUR;
  for (let i = 0; i < 9; i++) {
    const t = atTime(from + i * DAY, s.at);
    if (t <= from) continue;
    const day = new Date(t).getDay();
    if (s.kind === 'weekdays' && (day === 0 || day === 6)) continue;
    if (s.kind === 'weekly' && day !== s.day) continue;
    return t;
  }
  return 0;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function describeSchedule(s) {
  if (!s || s.kind === 'manual') return 'Run by hand';
  if (s.kind === 'hourly') return s.every === 1 ? 'Every hour' : `Every ${s.every} hours`;
  if (s.kind === 'daily') return `Every day at ${s.at}`;
  if (s.kind === 'weekdays') return `Weekdays at ${s.at}`;
  return `Every ${WEEKDAY[s.day]} at ${s.at}`;
}

/** Start whatever is due. Called every half minute by the server. */
function tick(state) {
  const t = Date.now();
  for (const card of state.cards) {
    if (card.archived) continue;
    for (const wf of card.workflows || []) {
      const due = nextRun(wf);
      if (!due || due > t) continue;
      if (isRunning(card.id, wf.id)) continue;
      if (running.size >= MAX_PARALLEL) return; // the rest wait for the next tick
      try {
        start(card.id, wf.id, 'schedule', card.view && card.view.folder);
      } catch (e) {
        logFn('workflow', card.key, wf.name, e.message);
        // a schedule that cannot start must not try again every half minute
        store.mutate((b) => {
          const c = b.cards.find((x) => x.id === card.id);
          const w = c && (c.workflows || []).find((x) => x.id === wf.id);
          if (w) w.lastScheduledAt = t;
        });
      }
    }
  }
}

// ---------- runs ----------

const logFile = (runId) => path.join(P.RUNS_DIR, `${path.basename(runId)}.jsonl`);
function removeLog(runId) {
  try {
    fs.rmSync(logFile(runId), { force: true });
  } catch (_) {}
}

const isRunning = (cardId, wfId) => [...running.values()].some((r) => r.cardId === cardId && r.workflowId === wfId);

/** Change one run on the board. */
function updateRun(cardId, runId, fn) {
  return store.mutate((b) => {
    const card = b.cards.find((c) => c.id === cardId);
    const run = card && (card.runs || []).find((r) => r.id === runId);
    if (run) fn(run, card, b);
    if (card) card.updatedAt = Date.now();
    return run;
  });
}

function systemNote(card, wf) {
  return [
    `You are running unattended: Taskboard started this run of the workflow "${wf.name}" on card ${card.key} "${card.title}".`,
    'Nobody is watching and nobody can answer a question, so do not ask any: decide sensibly, or stop and say what is missing.',
    'Anything that needs an approval is refused automatically; work with what you are allowed to do.',
    `You can read the card, its notes and what its sessions did with board_get_card (card: "${card.key}").`,
    'End with a short report of what you did and found, in plain words. The board saves that report on the card by itself, so do not add notes or change the board.',
  ].join(' ');
}

function buildArgs(card, wf, sessionId) {
  const access = ACCESS[wf.access] || ACCESS.read;
  const args = ['-p', wf.prompt, '--output-format', 'stream-json', '--verbose', '--session-id', sessionId, '--permission-prompts', 'none', '--append-system-prompt', systemNote(card, wf)];
  if (wf.access === 'full') args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', access.mode);
  if (wf.model) args.push('--model', wf.model);
  // reading the board is always allowed: it is how a run learns what its card is about
  args.push('--allowedTools', ...BOARD_READ);
  return args;
}

const AUTH = /\b(log ?in|logged out|authenticat\w*|oauth|401|credential\w*|expired)\b/i;
const AUTH_HINT = 'Claude is not logged in on this Mac, or its login expired. Run `claude` in a terminal and type /login, then run this again.';

/**
 * Start a run. `trigger` is "manual", "schedule" or "claude". `fallbackFolder` is where the
 * card's sessions work, for a workflow that does not name its own folder.
 */
function start(cardId, wfRef, trigger, fallbackFolder) {
  const bin = findClaude();
  if (!bin) throw new store.UserError('The claude command was not found. Install Claude Code, then try again.');
  if (running.size >= MAX_PARALLEL) throw new store.UserError(`${MAX_PARALLEL} workflows are already running. Wait for one to finish.`);
  const sessionId = crypto.randomUUID();
  const t = Date.now();
  // record the run first, so it shows at once and a second click cannot start it twice
  const made = store.mutate((b) => {
    const card = store.findCard(b, cardId);
    const wf = findWorkflow(card, wfRef);
    if (isRunning(card.id, wf.id)) throw new store.UserError(`“${wf.name}” is already running.`);
    const cwd = wf.folder || fallbackFolder || '';
    if (!cwd) throw new store.UserError(`No folder is known for “${wf.name}”. Edit it and say which folder it works in.`);
    let isDir = false;
    try {
      isDir = fs.statSync(cwd).isDirectory();
    } catch (_) {}
    if (!isDir) throw new store.UserError(`The folder ${cwd} does not exist.`);
    if (!Array.isArray(card.runs)) card.runs = [];
    const run = { id: 'r_' + rid(), workflowId: wf.id, trigger, status: 'running', startedAt: t, endedAt: 0, sessionId, cwd, activity: 'Starting Claude…', tools: 0, denied: 0, turns: 0, cost: 0, result: '', error: '', hint: '' };
    card.runs.push(run);
    // only the latest few runs of each workflow are kept, with their logs
    const mine = card.runs.filter((r) => r.workflowId === wf.id);
    for (const old of mine.slice(0, Math.max(0, mine.length - RUNS_KEPT))) {
      removeLog(old.id);
      card.runs = card.runs.filter((r) => r !== old);
    }
    if (trigger === 'schedule') wf.lastScheduledAt = t;
    wf.lastRunAt = t;
    // the run's session is the workflow's, not a loose end for the Unsorted list
    b.sessionMeta[sessionId] = { ...(b.sessionMeta[sessionId] || {}), hidden: true, workflow: wf.id };
    card.updatedAt = t;
    return { run, card: { id: card.id, key: card.key, title: card.title }, wf: { ...wf } };
  });
  const { run, card, wf } = made;
  fs.mkdirSync(P.RUNS_DIR, { recursive: true });
  const out = fs.openSync(logFile(run.id), 'a');
  let written = 0;
  const child = spawn(bin, buildArgs(card, wf, sessionId), { cwd: run.cwd, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const me = { child, cardId: card.id, workflowId: wf.id, stop: '', timer: null };
  running.set(run.id, me);
  logFn('workflow started:', card.key, wf.name, `(${trigger})`);

  // what the page shows while it works; written at most every 2 seconds
  const live = { activity: '', tools: 0, denied: 0, turns: 0, cost: 0, result: '', isError: false, errors: [] };
  let flushAt = 0;
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    flushAt = Date.now();
    updateRun(card.id, run.id, (r) => {
      if (r.status !== 'running') return;
      r.activity = live.activity || r.activity;
      r.tools = live.tools;
      r.denied = live.denied;
      r.turns = live.turns;
    });
  };
  const changed = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, Math.max(0, 2000 - (Date.now() - flushAt)));
  };

  const onEvent = (e) => {
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      live.turns += 1;
      for (const c of e.message.content) {
        if (c.type === 'tool_use') {
          live.tools += 1;
          live.activity = toolActivity(c);
        } else if (c.type === 'text' && c.text.trim()) live.activity = clean(c.text, 160);
      }
      changed();
    } else if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) if (c.type === 'tool_result' && c.is_error && DENIED.test(resultText(c))) live.denied += 1;
    } else if (e.type === 'system' && e.subtype === 'task_summary' && e.detail) {
      live.activity = clean(e.detail, 160);
      changed();
    } else if (e.type === 'result') {
      live.result = String(e.result || '');
      live.isError = !!e.is_error || (e.subtype && e.subtype !== 'success');
      live.cost = Number(e.total_cost_usd) || 0;
      if (e.num_turns) live.turns = e.num_turns;
      if (Array.isArray(e.errors)) live.errors.push(...e.errors.map(String));
    }
  };

  let buf = '';
  child.stdout.on('data', (chunk) => {
    if (written < LOG_MAX) {
      fs.writeSync(out, chunk);
      written += chunk.length;
    }
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch (_) {}
    }
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    if (stderr.length < 8000) stderr += c.toString('utf8');
  });
  me.timer = setTimeout(() => stop(run.id, 'timeout'), wf.timeoutMin * 60e3);
  me.timer.unref();

  let finished = false;
  const finish = (code, spawnError) => {
    if (finished) return;
    finished = true;
    clearTimeout(me.timer);
    if (flushTimer) clearTimeout(flushTimer);
    running.delete(run.id);
    try {
      fs.closeSync(out);
    } catch (_) {}
    if (stderr.trim()) {
      try {
        fs.appendFileSync(logFile(run.id), JSON.stringify({ type: 'stderr', text: stderr.slice(0, 8000) }) + '\n');
      } catch (_) {}
    }
    const failed = !!spawnError || code !== 0 || live.isError;
    const status = me.stop === 'timeout' ? 'timeout' : me.stop ? 'stopped' : failed ? 'failed' : 'succeeded';
    const error = spawnError
      ? spawnError.message
      : status === 'timeout'
        ? `Stopped after ${wf.timeoutMin} minutes, its time limit.`
        : status === 'stopped'
          ? 'Stopped by hand.'
          : failed
            ? clean(live.errors.join(' ') || (live.isError && live.result) || stderr || `Claude exited with code ${code}.`, 600)
            : '';
    const hint = status === 'failed' && AUTH.test(`${error} ${stderr} ${live.result}`) ? AUTH_HINT : '';
    let noteText = '';
    updateRun(card.id, run.id, (r, c) => {
      Object.assign(r, { status, endedAt: Date.now(), activity: '', tools: live.tools, denied: live.denied, turns: live.turns, cost: live.cost, result: live.result.slice(0, 6000), error, hint });
      const w = (c.workflows || []).find((x) => x.id === wf.id);
      if (w && w.postNote !== false && status !== 'stopped') {
        noteText =
          status === 'succeeded'
            ? `**Workflow “${w.name}” ran** (${r.trigger === 'schedule' ? 'on its schedule' : r.trigger === 'claude' ? 'started by Claude' : 'started by hand'}).\n\n${live.result.trim().slice(0, 3500) || '_It finished without a report._'}`
            : `**Workflow “${w.name}” ${status === 'timeout' ? 'hit its time limit' : 'failed'}.** ${hint || error}`;
      }
    });
    if (noteText) {
      try {
        store.apply('note.add', { card: card.id, by: `workflow · ${wf.name}`, text: noteText });
      } catch (_) {}
    }
    logFn('workflow', status + ':', card.key, wf.name);
  };
  child.on('error', (e) => finish(null, e));
  child.on('close', (code) => finish(code, null));
  return run;
}

const resultText = (c) => (typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : JSON.stringify(c.content || ''));

/** What a tool call is doing, in a few words. */
function toolActivity(c) {
  const i = c.input || {};
  const name = String(c.name || '').replace(/^mcp__[^_]+__/, '');
  const what = i.description || i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.prompt || '';
  return clean(`${name}${what ? ': ' + String(what).replace(os.homedir(), '~') : ''}`, 160);
}

/** Stop a run: politely first, then for good. */
function stop(runId, why) {
  const me = running.get(runId);
  if (!me) return false;
  me.stop = why || 'manual';
  try {
    me.child.kill('SIGTERM');
  } catch (_) {}
  setTimeout(() => {
    try {
      if (me.child.exitCode === null) me.child.kill('SIGKILL');
    } catch (_) {}
  }, 5000).unref();
  return true;
}

function stopAll() {
  for (const id of running.keys()) stop(id, 'manual');
}

/** Runs the board still shows as running that no process of ours is doing: the server stopped under them. */
function settleOrphans() {
  store.mutate((b) => {
    for (const c of b.cards) {
      for (const r of c.runs || []) {
        if (r.status === 'running' && !running.has(r.id)) Object.assign(r, { status: 'interrupted', endedAt: Date.now(), activity: '', error: 'The board stopped while this was running.' });
      }
    }
  });
}

/** A run's stream, as the few kinds of line the log view shows. */
function readLog(runId) {
  let text = '';
  try {
    text = fs.readFileSync(logFile(runId), 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (e.type === 'system' && e.subtype === 'init') out.push({ kind: 'status', text: `Started in ${String(e.cwd || '').replace(os.homedir(), '~')} with ${e.model || 'the default model'}` });
    else if (e.type === 'system' && e.subtype === 'task_summary' && e.detail) out.push({ kind: 'status', text: String(e.detail) });
    else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (c.type === 'text' && c.text.trim()) out.push({ kind: 'text', text: c.text.slice(0, 4000) });
        if (c.type === 'tool_use') out.push({ kind: 'tool', text: toolActivity(c) });
      }
    } else if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (c.type !== 'tool_result' || !c.is_error) continue;
        const text = resultText(c);
        const denied = DENIED.exec(text);
        out.push(denied ? { kind: 'denied', text: `Not allowed to use ${denied[1].replace(/^mcp__[^_]+__/, '')} here, so it was skipped.` } : { kind: 'error', text: clean(text, 400) });
      }
    } else if (e.type === 'result') {
      const text = String(e.result || (e.errors || []).join(' ') || '').slice(0, 6000);
      // the report is also the last thing Claude said: show it once
      const prev = out[out.length - 1];
      if (prev && prev.kind === 'text' && prev.text.trim() === text.trim().slice(0, 4000).trim()) out.pop();
      out.push({ kind: e.is_error ? 'error' : 'result', text });
    }
    else if (e.type === 'stderr') out.push({ kind: 'error', text: e.text });
  }
  return out.slice(-400);
}

module.exports = {
  ACCESS, SCHEDULES, MODELS, MAX_PARALLEL,
  findClaude, runEnv, check, nextRun, describeSchedule, tick, start, stop, stopAll, settleOrphans, readLog, buildArgs, findWorkflow, toolActivity,
  isRunning, running,
  setLog: (fn) => (logFn = fn),
};
