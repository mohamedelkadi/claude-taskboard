#!/usr/bin/env node
'use strict';
// `taskboard` — open the board, change it from a terminal, install or remove it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const P = require('./paths');
const store = require('./store');
const claude = require('./claude');
const view = require('./view');
const diary = require('./diary');
const search = require('./search');
const daemon = require('./daemon');
const macapp = require('./macapp');

const SRC_ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(P.DATA_DIR, 'app');
const BIN = path.join(os.homedir(), '.local', 'bin', 'taskboard');
const SKILL_DIR = path.join(P.CLAUDE_DIR, 'skills', 'board');
const MCP_NAME = 'taskboard';

const HELP = `taskboard — a kanban board over your Claude sessions

  taskboard                     open the board (the Taskboard app, or the browser without it)
  taskboard open [card] [--browser]
  taskboard start | stop | restart | status
  taskboard ls [--all]          the board as text (--all includes done columns)
  taskboard show <card>         one card in full (key like TB-3, or title)
  taskboard add "<title>" [--status "In progress"] [--ticket PROJ-1] [--project name] [--priority high]
  taskboard move <card> <column>
  taskboard sub <card> "<title>"            add a checklist sub-task
  taskboard note <card> "<text>"
  taskboard link <card> [session-id]        link a session (default: the Claude session running this)
  taskboard connect <from> <to> [blocks|relates|parent]
  taskboard sessions [query] [--unsorted]   find sessions
  taskboard search "<words>" [--project name] [--limit 10]   search inside every conversation
  taskboard diary [today|yesterday|YYYY-MM-DD] [--days 7] [--project name]   what you did
  taskboard diary --search "<words>"         search every day
  taskboard app [--remove]      build the Mac app into ~/Applications (needs Xcode's Swift)
  taskboard doctor              check the installation
  taskboard install | uninstall [--purge]   (uninstall keeps your board unless --purge)

Board data: ${P.DATA_DIR}
`;

const SWITCHES = new Set(['all', 'browser', 'remove', 'purge', 'unsorted']); // flags that take no value

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (!SWITCHES.has(a.slice(2)) && next !== undefined && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

function snapshot() {
  const scanResult = claude.scan();
  if (!store.exists()) view.seed(scanResult); // first use, before the web server got to it
  view.applyAutoLinks(scanResult);
  view.applyAutoMoves(scanResult);
  return view.buildState(store.load(), scanResult);
}

function findClaude() {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const r = spawnSync('which', ['claude'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function mcpRegistered() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const entry = cfg.mcpServers && cfg.mcpServers[MCP_NAME];
    return entry ? entry : null;
  } catch (_) {
    return null;
  }
}

async function install() {
  const steps = [];
  // 1. the app itself, somewhere that outlives wherever it was built
  fs.mkdirSync(P.DATA_DIR, { recursive: true });
  if (path.resolve(SRC_ROOT) !== path.resolve(APP_DIR)) {
    await daemon.stop();
    fs.rmSync(APP_DIR, { recursive: true, force: true });
    fs.mkdirSync(APP_DIR, { recursive: true });
    for (const item of ['src', 'public', 'skill', 'macapp', 'test', 'package.json', 'README.md']) {
      const from = path.join(SRC_ROOT, item);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(APP_DIR, item), { recursive: true });
    }
    steps.push(`app copied to ${APP_DIR}`);
  }
  // 2. the command. The Node path is absolute on purpose: version managers
  //    pick a different Node per folder, and sessions run in many folders.
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  fs.writeFileSync(BIN, `#!/bin/sh\nexec "${process.execPath}" "${path.join(APP_DIR, 'src', 'cli.js')}" "$@"\n`, { mode: 0o755 });
  steps.push(`command installed at ${BIN}`);
  // 3. the skill that tells Claude sessions when and how to use the board
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, 'skill', 'SKILL.md'), path.join(SKILL_DIR, 'SKILL.md'));
  steps.push(`skill installed at ${SKILL_DIR}`);
  // 4. the MCP server, for every Claude Code session of this user
  const cli = findClaude();
  if (cli) {
    spawnSync(cli, ['mcp', 'remove', '--scope', 'user', MCP_NAME], { encoding: 'utf8' });
    const r = spawnSync(cli, ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', process.execPath, path.join(APP_DIR, 'src', 'mcp.js')], { encoding: 'utf8' });
    steps.push(r.status === 0 ? 'MCP server registered for all your Claude sessions' : `MCP registration failed: ${(r.stderr || r.stdout || '').trim()}`);
  } else steps.push('claude command not found: MCP server not registered');
  // 5. start it from the installed copy
  const r = spawnSync(process.execPath, [path.join(APP_DIR, 'src', 'cli.js'), 'start'], { encoding: 'utf8' });
  steps.push((r.stdout || r.stderr || '').trim());
  // 6. the Mac app: Dock icon, own window, menu-bar count
  if (macapp.available()) {
    try {
      const built = macapp.build();
      steps.push(`Mac app installed at ${built.path}`);
      if (built.wasRunning) macapp.open(); // it was open: bring the new build back
    } catch (e) {
      steps.push(`Mac app not built: ${e.message}`);
    }
  } else steps.push('Mac app skipped: it needs the Swift compiler that comes with Xcode');
  console.log(steps.map((s) => `- ${s}`).join('\n'));
  console.log(`\nBoard: ${P.boardUrl()}`);
}

async function uninstall(purge) {
  if (macapp.installed()) {
    // take it out of Login Items first, or macOS keeps a dead entry
    spawnSync(path.join(macapp.APP, 'Contents', 'MacOS', 'Taskboard'), ['--login', 'off'], { encoding: 'utf8' });
    macapp.remove();
  }
  await daemon.stop();
  const cli = findClaude();
  if (cli) spawnSync(cli, ['mcp', 'remove', '--scope', 'user', MCP_NAME], { encoding: 'utf8' });
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  fs.rmSync(BIN, { force: true });
  if (purge) {
    fs.rmSync(P.DATA_DIR, { recursive: true, force: true });
    console.log(`Removed the board, its data and its Claude integration.`);
  } else {
    fs.rmSync(APP_DIR, { recursive: true, force: true });
    fs.rmSync(P.CACHE_DIR, { recursive: true, force: true });
    console.log(`Removed the app and its Claude integration. Your board and diary are kept in ${P.DATA_DIR}.`);
  }
}

async function doctor() {
  const ok = (good, label, hint) => console.log(`${good ? 'ok  ' : 'FAIL'} ${label}${!good && hint ? ` — ${hint}` : ''}`);
  const up = await daemon.health();
  ok(!!up, `board server ${up ? `running (pid ${up.pid}) at ${P.boardUrl()}` : 'not running'}`, 'run: taskboard start');
  ok(store.exists(), `board file ${P.BOARD_FILE}`, 'it is created the first time the board starts');
  ok(fs.existsSync(P.DESKTOP_SESSIONS_DIR), `Claude desktop sessions at ${P.DESKTOP_SESSIONS_DIR}`, 'the Claude desktop app has no Code sessions on this Mac');
  ok(fs.existsSync(P.PROJECTS_DIR), `Claude transcripts at ${P.PROJECTS_DIR}`);
  const entry = mcpRegistered();
  const target = entry && Array.isArray(entry.args) && entry.args[0];
  ok(!!entry && !!target && fs.existsSync(target), `MCP server registered${target ? ` (${target})` : ''}`, 'run: taskboard install');
  ok(fs.existsSync(path.join(SKILL_DIR, 'SKILL.md')), `skill at ${SKILL_DIR}`, 'run: taskboard install');
  ok(fs.existsSync(BIN), `command at ${BIN}`, 'run: taskboard install');
  ok(macapp.installed(), `Mac app at ${macapp.APP}${macapp.installed() && macapp.isRunning() ? ' (running)' : ''}`, macapp.available() ? 'run: taskboard app' : 'needs Xcode; the board still works in the browser');
  const scan = claude.scan();
  console.log(`     ${scan.sessions.length} sessions found, ${scan.sessions.filter((s) => !s.archived).length} not archived, ${scan.groups.length} sidebar groups`);
  const kept = diary.stats();
  console.log(`     diary: ${kept.days} days, ${Math.max(1, Math.round(kept.bytes / 1024))} KB in ${P.DIARY_DIR}`);
  const index = search.status();
  console.log(index.available
    ? `     conversation search: ${index.sessions} sessions, ${Math.round((index.bytes || 0) / 1e6)} MB in ${search.DB_FILE}`
    : `     conversation search: off, it needs Node 22.13 or newer (this is ${index.node})`);
  if (up && up.error) console.log(`     last scan error: ${up.error}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'open';
  const f = flags(argv.slice(1));
  const a = f._;
  switch (cmd) {
    case 'open': {
      await daemon.start();
      const card = a.length ? store.findCard(store.load(), a.join(' ')) : null;
      if (!f.browser && macapp.installed()) macapp.open(card ? `card/${card.key}` : '');
      else execFileSync('open', [P.boardUrl(card ? 'card=' + card.key : '')]);
      return console.log(card ? `Opened ${card.key} ${card.title}` : `Board: ${P.boardUrl()}`);
    }
    case 'app': {
      if (f.remove) {
        macapp.remove();
        return console.log('Mac app removed.');
      }
      const built = macapp.build();
      await daemon.start();
      macapp.open();
      return console.log(`Taskboard app installed at ${built.path} and opened.\nTo keep it in the Dock: right-click its Dock icon → Options → Keep in Dock.`);
    }
    case 'start': {
      const r = await daemon.start();
      return console.log(`${r.started ? 'board started' : 'board already running'} (pid ${r.pid}) at ${P.boardUrl()}`);
    }
    case 'stop': {
      const r = await daemon.stop();
      return console.log(r.stopped ? 'board stopped' : 'board was not running');
    }
    case 'restart': {
      await daemon.stop();
      const r = await daemon.start();
      return console.log(`board restarted (pid ${r.pid}) at ${P.boardUrl()}`);
    }
    case 'status': {
      const up = await daemon.health();
      return console.log(up ? `running (pid ${up.pid}) at ${P.boardUrl()} — ${up.sessions} sessions` : 'not running');
    }
    case 'ls': {
      const state = snapshot();
      const done = new Set(state.columns.filter((c) => c.done).map((c) => c.id));
      for (const col of state.columns) {
        const cards = state.cards.filter((c) => c.status === col.id && !c.archived).sort((x, y) => x.order - y.order);
        console.log(`\n${col.name} (${cards.length})`);
        if (done.has(col.id) && !f.all) continue;
        for (const c of cards) {
          const v = c.view;
          const bits = [`${v.counts.done}/${v.counts.total}`];
          if (v.counts.running) bits.push(`${v.counts.running} running`);
          if (v.counts.needs) bits.push(`${v.counts.needs} need you`);
          console.log(`  ${c.key.padEnd(7)} ${c.title}${c.ticket ? ` [${c.ticket}]` : ''}  (${bits.join(', ')})`);
        }
      }
      return console.log('');
    }
    case 'show': {
      const state = snapshot();
      return console.log(view.cardMarkdown(store.findCard({ cards: state.cards }, a.join(' ')), state));
    }
    case 'add': {
      const card = store.apply('card.create', { title: a.join(' '), status: f.status, ticket: f.ticket, project: f.project, priority: f.priority, auto: f.ticket ? { ticketKeys: [f.ticket] } : undefined });
      return console.log(`created ${card.key} ${card.title}`);
    }
    case 'move': {
      const card = store.apply('card.update', { card: a[0], status: a.slice(1).join(' ') });
      return console.log(`${card.key} is now in ${store.findColumn(store.load(), card.status).name}`);
    }
    case 'sub': {
      const sub = store.apply('subtask.add', { card: a[0], title: a.slice(1).join(' ') });
      return console.log(`added sub-task "${sub.title}"`);
    }
    case 'note': {
      store.apply('note.add', { card: a[0], text: a.slice(1).join(' ') });
      return console.log('note added');
    }
    case 'link': {
      const me = claude.currentSession();
      const sid = a[1] || (me && me.id);
      if (!sid) throw new store.UserError('Give a session id (taskboard sessions lists them), or run this inside a Claude session.');
      const card = store.apply('session.link', { card: a[0], sessionIds: [sid], via: 'manual' });
      return console.log(`linked ${sid} to ${card.key}`);
    }
    case 'connect': {
      const r = store.apply('link.add', { from: a[0], to: a[1], type: a[2] || 'relates' });
      return console.log(`${r.from} —${r.type}→ ${r.to}`);
    }
    case 'sessions': {
      const state = snapshot();
      const q = a.join(' ').toLowerCase();
      const cardById = new Map(state.cards.map((c) => [c.id, c]));
      const list = state.sessions
        .filter((s) => !s.archived && (!f.unsorted || (!s.cardId && !s.hidden)) && (!q || `${s.title} ${s.projectName} ${s.tickets.join(' ')}`.toLowerCase().includes(q)))
        .sort((x, y) => y.lastActivityAt - x.lastActivityAt)
        .slice(0, 40);
      for (const s of list) {
        const card = s.cardId && cardById.get(s.cardId);
        console.log(`${s.id}  ${view.STATE_LABEL[s.estate].padEnd(16)} ${s.title.slice(0, 60).padEnd(60)} ${card ? card.key : '-'}`);
      }
      return;
    }
    case 'search': {
      if (!a.length) throw new store.UserError('Give some words to search for: taskboard search "<words>"');
      return console.log(search.markdown({ q: a.join(' '), limit: f.limit, project: f.project }, snapshot()));
    }
    case 'diary': {
      const day = a.length ? diary.parseDay(a[0]) : '';
      if (a.length && !day) throw new store.UserError('Give the day as today, yesterday or YYYY-MM-DD.');
      const state = snapshot();
      diary.setNotes(store.load().dayNotes);
      return console.log(diary.markdown({ day, days: f.days, q: typeof f.search === 'string' ? f.search : '', project: f.project }, state));
    }
    case 'path':
      return console.log(P.DATA_DIR);
    case 'doctor':
      return doctor();
    case 'install':
      return install();
    case 'uninstall':
      return uninstall(!!f.purge);
    case 'help':
    case '--help':
    case '-h':
      return console.log(HELP);
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof store.UserError ? e.message : e.stack || e.message);
  process.exitCode = 1;
});
