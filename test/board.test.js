'use strict';
const fx = require('./fixture');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/paths');
const store = require('../src/store');
const claude = require('../src/claude');
const view = require('../src/view');

after(fx.cleanup);

const state = () => view.buildState(store.load(), claude.scan());
const card = (st, title) => st.cards.find((c) => c.title === title);

test('scan reads sessions, groups, tickets and the transcript step list', async () => {
  const scan = claude.scan();
  assert.equal(scan.sessions.length, 6);
  assert.deepEqual(scan.groups, [{ id: 'cg-1', name: 'Search' }]);
  const root = scan.sessions.find((s) => s.id === fx.ids.root);
  assert.equal(root.groupId, 'cg-1');
  assert.equal(root.state, 'needs_you');
  assert.deepEqual(root.tickets, ['PROJ-100']);
  // "review-26397" in a branch name is not a ticket
  assert.deepEqual(scan.sessions.find((s) => s.id === fx.ids.other).tickets, []);

  const detail = await claude.sessionDetail(root);
  assert.deepEqual(detail.plan.map((i) => i.status), ['completed', 'in_progress', 'pending'], 'a repeated log line advances once');
  assert.equal(detail.firstPrompt, 'fix the search ranking');
  assert.equal(detail.lastPrompt, 'and add a test');
  assert.equal(detail.cost, 1.24);
});

test('a session started in a folder of several repos also counts for the repos it worked in', () => {
  // started in ~/work, which holds the repos; ran commands in two of them and in a scratch folder
  const id = `local_${fx.uuid(900)}`;
  const file = path.join(fx.sessDir, `${id}.json`);
  fx.desktopSession(id, 90, {
    cwd: '/work', originCwd: '/work',
    shellFolders: ['/work/api', '/work/app/.claude/worktrees/fix', '/work/api', '/work', '/private/tmp/claude-501/x/scratchpad', '/tmp/y', 42],
  });
  try {
    const s = claude.scan().sessions.find((x) => x.id === id);
    assert.equal(s.projectName, 'work');
    assert.deepEqual(s.alsoIn, ['api', 'app'], 'repos once each, worktrees folded into their repo, no scratch folders, not itself');
    // a session with no shellFolders has none
    assert.deepEqual(claude.scan().sessions.find((x) => x.id === fx.ids.root).alsoIn, []);
  } finally {
    fs.rmSync(file);
  }
});

test('a transcript is read incrementally as it grows', async () => {
  const root = claude.scan().sessions.find((s) => s.id === fx.ids.root);
  fs.appendFileSync(fx.transcript, fx.tool('t3', 'mcp__ccd_turn__wrap_up', { recap: 'Fixed the ranking.', ask: 'Ship it?' }) + '\n');
  const detail = await claude.sessionDetail(root);
  assert.deepEqual(detail.plan.map((i) => i.status), ['completed', 'completed', 'pending']);
  assert.equal(detail.wrap.recap, 'Fixed the ranking.');
  const again = claude.scan().sessions.find((s) => s.id === fx.ids.root);
  assert.deepEqual(again.steps, { total: 3, done: 2, current: '' });
});

test('first run imports sidebar groups, session families and scheduled tasks', () => {
  const made = view.seed(claude.scan());
  assert.deepEqual(made, { groups: 1, families: 0, routines: 1 });
  const st = state();
  const search = card(st, 'Search');
  assert.equal(search.ticket, '');
  assert.equal(search.auto.groupId, 'cg-1');
  // the root came in by group, its child by the "started from" rule
  assert.deepEqual(search.view.subs.map((s) => [s.sessionId, s.via, s.status]), [[fx.ids.root, 'group', 'blocked'], [fx.ids.child, 'child', 'done']]);
  assert.deepEqual(search.view.counts, { total: 2, done: 1, running: 0, needs: 1, review: 0 });
  const daily = card(st, 'Daily report');
  assert.equal(daily.status, 'waiting');
  assert.equal(daily.view.subs.length, 1, 'all runs are one sub-task');
  assert.equal(daily.view.subs[0].runs, 2);
  assert.equal(daily.view.subs[0].status, 'blocked');
  assert.equal(view.seed(claude.scan()), null, 'never imports twice');
});

test('unsorted sessions get a suggestion from a shared PR; archived ones settle as done', () => {
  const st = state();
  const other = st.sessions.find((s) => s.id === fx.ids.other);
  assert.equal(other.cardId, null);
  assert.equal(other.suggest.cardId, card(st, 'Search').id);
  assert.match(other.suggest.reason, /PR #7/);
  assert.equal(st.sessions.find((s) => s.id === fx.ids.old).estate, 'done');
});

test('cards move between columns and keep their order', () => {
  const a = store.apply('card.create', { title: 'A', status: 'To do' });
  const b = store.apply('card.create', { title: 'B', status: 'todo' });
  const c = store.apply('card.create', { title: 'C', status: 'in progress' });
  const order = (col) => store.load().cards.filter((x) => x.status === col).sort((x, y) => x.order - y.order).map((x) => x.title);
  assert.deepEqual(order('todo'), ['B', 'A'], 'new cards go on top');
  store.apply('card.move', { card: c.id, status: 'todo', beforeId: a.id });
  assert.deepEqual(order('todo'), ['B', 'C', 'A']);
  store.apply('card.move', { card: b.key, status: 'todo' });
  assert.deepEqual(order('todo'), ['C', 'A', 'B'], 'no beforeId drops at the end');
  assert.equal(store.apply('card.update', { card: 'A', status: 'Done' }).status, 'done');
  assert.throws(() => store.apply('card.update', { card: a.id, status: 'nope' }), /No column/);
});

test('a session sits on one card; taking it off by hand keeps it off', () => {
  const st0 = state();
  const search = card(st0, 'Search');
  const a = card(st0, 'A');
  store.apply('session.link', { card: a.id, sessionIds: [fx.ids.child] });
  let st = state();
  assert.equal(st.sessions.find((s) => s.id === fx.ids.child).cardId, a.id);
  assert.ok(!card(st, 'Search').view.subs.some((s) => s.sessionId === fx.ids.child), 'linking moved it');
  assert.equal(st.implicit.length, 1, 'the two cards are now detected as related');
  assert.match(st.implicit[0].reasons[0], /was started from/);

  store.apply('session.unlink', { sessionIds: [fx.ids.child] });
  assert.equal(view.applyAutoLinks(claude.scan()), 0, 'not pulled back by the "started from" rule');
  assert.equal(state().sessions.find((s) => s.id === fx.ids.child).cardId, null);

  // a ticket rule claims sessions that mention the key
  store.apply('card.update', { card: a.id, auto: { ticketKeys: ['proj-100'] } });
  store.apply('session.unlink', { sessionIds: [fx.ids.root] });
  store.mutate((b) => delete b.sessionMeta[fx.ids.root]);
  store.apply('card.update', { card: search.id, auto: { groupId: '' } });
  assert.equal(view.applyAutoLinks(claude.scan()), 1);
  assert.equal(state().sessions.find((s) => s.id === fx.ids.root).cardId, a.id);
});

test('"mark handled" hides a request until the session asks again', () => {
  let st = state();
  const root = st.sessions.find((s) => s.id === fx.ids.root);
  assert.equal(root.estate, 'needs_you');
  store.apply('session.meta', { sessionIds: [root.id], ack: { [root.id]: root.token } });
  assert.equal(state().sessions.find((s) => s.id === root.id).estate, 'idle');
  fx.desktopSession(fx.ids.root, 1, { title: 'PROJ-100 search root', postTurnSummary: { status_category: 'blocked', needs_action: 'a new question', summarizes_uuid: 'u-2' } });
  assert.equal(state().sessions.find((s) => s.id === root.id).estate, 'needs_you');
});

test('sub-tasks, connections, notes and columns', () => {
  const a = store.findCard(store.load(), 'A');
  const b = store.findCard(store.load(), 'B');
  const sub = store.apply('subtask.add', { card: a.id, title: 'write tests' });
  store.apply('subtask.update', { card: a.id, subtask: 'write tests', status: 'done' });
  assert.throws(() => store.apply('subtask.update', { card: a.id, subtask: sub.id, status: 'auto' }), /status is one of/, 'auto is for linked sessions only');

  store.apply('link.add', { from: a.id, to: b.id, type: 'blocks' });
  store.apply('link.add', { from: b.id, to: a.id, type: 'relates' });
  const links = store.load().cards.flatMap((c) => c.links.map((l) => [c.title, l.type]));
  assert.deepEqual(links, [['B', 'relates']], 'one connection per pair');
  assert.throws(() => store.apply('link.add', { from: a.id, to: a.id }), /itself/);

  store.apply('note.add', { card: a.id, text: 'decided to ship', by: 'claude · test' });
  const md = view.cardMarkdown(card(state(), 'A'), state());
  assert.match(md, /\[x\] write tests/);
  assert.match(md, /related to TB-\d+ · B/);
  assert.match(md, /decided to ship/);

  store.apply('columns.set', { columns: [{ id: 'todo', name: 'Next' }, { name: 'Shipped', done: true }] });
  const after = store.load();
  assert.deepEqual(after.columns.map((c) => c.name), ['Next', 'Shipped']);
  assert.ok(after.cards.every((c) => ['todo', 'shipped'].includes(c.status)), 'cards from deleted columns are kept');

  store.apply('card.delete', { card: b.id });
  assert.ok(!store.load().cards.some((c) => c.links.some((l) => l.to === b.id)));
});

test('a new session starts in the folder of the card\'s project', () => {
  const dir = (name) => {
    const d = path.join(fx.root, 'code', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const api = dir('shop-api');
  const web = dir('shop-web');
  const other = path.join(dir('elsewhere'), 'shop-api'); // a second folder with the same name
  fs.mkdirSync(other);
  const sessions = [
    { id: 's1', project: api, projectName: 'shop-api', lastActivityAt: 10 },
    { id: 's2', project: web, projectName: 'shop-web', lastActivityAt: 30 },
    { id: 's3', project: other, projectName: 'shop-api', lastActivityAt: 20 },
    { id: 's4', project: '(no folder)', projectName: 'No folder', lastActivityAt: 40 },
    { id: 's5', project: path.join(fx.root, 'code', 'deleted'), projectName: 'deleted', lastActivityAt: 50 },
  ];
  const folderOf = view.folderResolver(sessions);
  const sub = (id) => ({ sessionId: id });

  // the bug this fixes: a card for one project whose only session was started in another folder
  assert.equal(folderOf({ project: 'shop-web', subtasks: [sub('s1')] }), web, 'the project named on the card wins over where its sessions ran');
  assert.equal(folderOf({ project: 'Shop-API', subtasks: [] }), other, 'same name twice: the folder used last');
  assert.equal(folderOf({ project: 'shop-api', subtasks: [sub('s1')] }), api, 'same name twice: the folder this card already uses');
  assert.equal(folderOf({ project: '', subtasks: [sub('s2'), sub('s4')] }), web, 'no project on the card: where its sessions ran');
  assert.equal(folderOf({ project: 'never-seen', subtasks: [] }), '', 'a project no session has run in');
  assert.equal(folderOf({ project: 'deleted', subtasks: [sub('s5')] }), '', 'a folder that is gone');
  assert.equal(folderOf({ project: '', subtasks: [sub('s4')] }), '', 'sessions with no folder');

  const brief = view.sessionBrief({ key: 'TB-1', title: 'Saved cards' }, web);
  assert.ok(brief.includes(`in the project folder ${web} (`));
  const url = new URL(view.newSessionUrl(brief, '/Users/me/My Work /app'));
  assert.equal(url.protocol + '//' + url.host + url.pathname, 'claude://code/new');
  assert.equal(url.searchParams.get('folder'), '/Users/me/My Work /app');
  assert.equal(url.searchParams.get('q'), brief);
  assert.equal(new URL(view.newSessionUrl('hi', '')).searchParams.has('folder'), false);
});

test('a card that has not started moves to In progress when one of its sessions works', () => {
  // an earlier test cut the board down to two columns; a board with no "in progress" column moves nothing
  const found = store.load().columns;
  const lone = store.apply('card.create', { title: 'Nowhere to go' });
  fx.desktopSession(fx.ids.other, 3, { title: 'Unrelated work', lastActivityAt: Date.now() + 60e3 });
  store.apply('session.link', { card: lone.id, sessionIds: [fx.ids.other] });
  assert.deepEqual(view.applyAutoMoves(claude.scan()), []);
  store.apply('columns.set', { columns: [{ id: 'todo', name: 'Next' }, { name: 'Doing' }, { name: 'Checking' }, { name: 'Shipped', done: true }] });
  assert.deepEqual(view.applyAutoMoves(claude.scan()), [lone.key], 'a column named like "in progress" counts');
  store.apply('card.delete', { card: lone.id });
  store.apply('columns.set', { columns: store.DEFAULT_COLUMNS });

  const made = store.apply('card.create', { title: 'Follow me', status: 'To do' });
  const put = (ago) => store.mutate((b) => (b.cards.find((c) => c.id === made.id).statusAt = Date.now() - ago));
  const column = () => card(state(), 'Follow me').status;
  // the card was put in To do a minute ago; its session last worked half a minute ago
  fx.desktopSession(fx.ids.other, 3, { title: 'Unrelated work', lastActivityAt: Date.now() - 30e3 });
  put(60e3);
  store.apply('session.link', { card: made.id, sessionIds: [fx.ids.other] });
  assert.deepEqual(view.applyAutoMoves(claude.scan()), [made.key]);
  assert.equal(column(), 'in_progress');
  assert.deepEqual(view.applyAutoMoves(claude.scan()), [], 'once there, nothing more to do');

  // put back by hand: work done before that does not move it again
  store.apply('card.update', { card: made.id, status: 'To do' });
  assert.deepEqual(view.applyAutoMoves(claude.scan()), []);
  assert.equal(column(), 'todo');
  // a session that is working right now does
  const live = path.join(P.LIVE_DIR, '4242.json');
  fs.writeFileSync(live, JSON.stringify({ pid: process.pid, status: 'busy', sessionId: fx.uuid(103), hostSessionId: fx.ids.other, cwd: '/work/app', name: 'x' }));
  assert.deepEqual(view.applyAutoMoves(claude.scan()), [made.key]);
  fs.rmSync(live);

  // it only ever moves forward, and can be switched off
  store.apply('card.update', { card: made.id, status: 'In review' });
  put(60e3);
  assert.deepEqual(view.applyAutoMoves(claude.scan()), [], 'a card past In progress is left alone');
  store.apply('card.update', { card: made.id, status: 'Backlog' });
  put(60e3);
  store.apply('settings.update', { followSessions: false });
  assert.deepEqual(view.applyAutoMoves(claude.scan()), []);
  store.apply('settings.update', { followSessions: true });
  assert.deepEqual(view.applyAutoMoves(claude.scan()), [made.key]);
  store.apply('columns.set', { columns: found }); // as the next tests expect it
});

test('a session started with a card\'s brief joins that card on its own', async () => {
  const made = store.apply('card.create', { title: 'Started from the board' });
  const id = `local_${fx.uuid(7)}`;
  fx.desktopSession(id, 7, { title: 'A title Claude made up' });
  fs.writeFileSync(
    path.join(P.PROJECTS_DIR, '-work-app', `${fx.uuid(107)}.jsonl`),
    JSON.stringify({ type: 'user', isSidechain: false, cwd: '/work/app', timestamp: new Date().toISOString(), message: { role: 'user', content: view.sessionBrief(made, '/work/app') + 'fix it' } }) + '\n'
  );
  claude.scan(); // notices the new transcript, as the board does before it reads one
  await claude.scanTranscript(fx.uuid(107));
  const scan = claude.scan();
  assert.equal(scan.sessions.find((s) => s.id === id).briefCard, made.key);
  assert.equal(view.applyAutoLinks(scan), 1);
  const sub = card(state(), 'Started from the board').view.subs[0];
  assert.deepEqual([sub.sessionId, sub.via], [id, 'brief']);
  // taken off by hand, it stays off
  store.apply('session.unlink', { sessionIds: [id] });
  assert.equal(view.applyAutoLinks(claude.scan()), 0);
});

test('a link typed as the ticket is kept as typed, and is not a ticket key', () => {
  const link = 'https://acme.slack.com/archives/C04ABC/p1795';
  const made = store.apply('card.create', { title: 'With a link', ticket: link, auto: { ticketKeys: [link, 'shop-9'] } });
  assert.equal(made.ticket, link);
  assert.deepEqual(made.auto.ticketKeys, ['SHOP-9']);
  assert.equal(store.apply('card.update', { card: made.id, ticket: 'proj-12' }).ticket, 'PROJ-12');
  // what an earlier version stored is put right when the board is read
  store.mutate((b) => {
    const c = b.cards.find((x) => x.id === made.id);
    c.ticket = link.toUpperCase();
    c.description = `see ${link} for the thread`;
    c.auto.ticketKeys = ['HTTPS://ACME.SLACK.COM/ARCHI'];
  });
  const read = store.load().cards.find((x) => x.id === made.id);
  assert.equal(read.ticket, link);
  assert.deepEqual(read.auto.ticketKeys, []);
});

test('a card finds its session again under a new id, and remembers its name once it is gone', () => {
  const made = store.apply('card.create', { title: 'Keeps its session' });
  const first = `local_${fx.uuid(8)}`;
  fx.desktopSession(first, 8, { title: 'Named session' });
  store.apply('session.link', { card: made.id, sessionIds: [first] });
  assert.equal(view.applyRemember(claude.scan()), 0, 'nothing to find yet; the name and transcript are noted');
  const sub = () => card(state(), 'Keeps its session').view.subs[0];

  // Claude drops the record and makes a new one for the same transcript
  fs.rmSync(path.join(fx.sessDir, `${first}.json`));
  const second = `local_${fx.uuid(9)}`;
  fx.desktopSession(second, 9, { title: 'Named session', cliSessionId: fx.uuid(108) });
  assert.equal(view.applyRemember(claude.scan()), 1);
  assert.equal(sub().sessionId, second);
  assert.ok(!sub().missing);

  // gone for good: the card still says what it was
  fs.rmSync(path.join(fx.sessDir, `${second}.json`));
  view.applyRemember(claude.scan());
  assert.equal(sub().missing, true);
  assert.equal(sub().title, 'Named session');
});

test('card files are written for Claude and removed with the card', () => {
  view.exportMarkdown(state());
  const a = store.findCard(store.load(), 'A');
  const file = path.join(P.CARDS_DIR, `${a.key}.md`);
  assert.match(fs.readFileSync(file, 'utf8'), /^# TB-\d+ · A/);
  assert.match(fs.readFileSync(P.OVERVIEW_FILE, 'utf8'), /## Next/);
  store.apply('card.delete', { card: a.id });
  view.exportMarkdown(state());
  assert.ok(!fs.existsSync(file));
});

test('a damaged board file is reported, never replaced with an empty board', () => {
  const good = fs.readFileSync(P.BOARD_FILE, 'utf8');
  fs.writeFileSync(P.BOARD_FILE, '{ not json');
  assert.throws(() => store.apply('card.create', { title: 'x' }), /Cannot read/);
  assert.equal(fs.readFileSync(P.BOARD_FILE, 'utf8'), '{ not json');
  fs.writeFileSync(P.BOARD_FILE, good);
});
