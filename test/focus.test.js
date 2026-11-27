'use strict';
// Focus mode: finding the prompt a session is stopped on, and which sessions come up.
const fx = require('./fixture');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/paths');
const store = require('../src/store');
const claude = require('../src/claude');
const view = require('../src/view');
const focus = require('../src/focus');

const liveFile = path.join(P.LIVE_DIR, `${process.pid}.json`);
after(() => {
  fs.rmSync(liveFile, { force: true });
  fx.cleanup();
});

const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const say = (message, ...blocks) => JSON.stringify({ type: 'assistant', message: { id: message, role: 'assistant', content: blocks } });
const answer = (id) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const ids = (calls) => calls.map((c) => c.id);
const question = (text) => ({ questions: [{ header: 'Scope', question: text, multiSelect: false, options: [{ label: 'Yes', description: 'Do it' }, { label: 'No' }] }] });
const live = { waitingFor: 'input needed', statusAt: 1000 };

test('the open calls are the last message\'s calls that have no result', () => {
  assert.deepEqual(ids(focus.unanswered([say('m1', use('a', 'Bash', {})), answer('a')])), [], 'answered');
  assert.deepEqual(ids(focus.unanswered([say('m1', use('a', 'Bash', {})), say('m2', use('b', 'Edit', {}))])), ['b'], 'a newer message replaces an abandoned call');
  assert.deepEqual(ids(focus.unanswered([say('m1', use('a', 'Bash', {})), say('m1', use('b', 'Read', {})), answer('a')])), ['b'], 'parallel calls of one message');
  assert.deepEqual(ids(focus.unanswered([say('m1', use('a', 'Bash', {})), say('m1', use('a', 'Bash', {}))])), ['a'], 'a call logged twice is one call');
  assert.deepEqual(ids(focus.unanswered([say('m1', use('a', 'Bash', {})), say('m2', { type: 'text', text: 'done' })])), [], 'a later message with no calls');
  const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'x', content: [use('s', 'Bash', {})] } });
  assert.deepEqual(ids(focus.unanswered([side, '{"type":"assistant", cut off'])), [], 'subagent lines and a half-written line');
});

test('each kind of prompt is read from its call', () => {
  const q = focus.promptFrom([use('q1', 'AskUserQuestion', question('Ship it?'))], live);
  assert.equal(q.kind, 'question');
  assert.equal(q.ask, 'Ship it?');
  assert.equal(q.token, 'live:q1');
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Yes', 'No']);

  const plan = focus.promptFrom([use('p1', 'ExitPlanMode', { plan: '# Do the thing', planFilePath: '/tmp/plan.md' })], live);
  assert.equal(plan.kind, 'plan');
  assert.equal(plan.plan, '# Do the thing');

  const bash = focus.promptFrom([use('b1', 'Bash', { command: 'npm test', description: 'Run tests' })], live);
  assert.equal(bash.kind, 'permission');
  assert.equal(bash.ask, 'Run a command: npm test');
  assert.equal(bash.calls[0].note, 'Run tests');

  const edit = focus.promptFrom([use('e1', 'Edit', { file_path: '/a.js', old_string: 'one', new_string: 'two' })], live);
  assert.equal(edit.calls[0].text, '- one\n+ two');

  const mcp = focus.promptFrom([use('m1', 'mcp__slack__send_message', { text: 'hi' })], live);
  assert.equal(mcp.calls[0].label, 'Use send_message');

  const many = focus.promptFrom([use('a', 'Bash', { command: 'x' }), use('b', 'Bash', { command: 'y' })], live);
  assert.equal(many.ask, 'Waiting on one of 2 tool calls.', 'it does not claim to know which one');

  assert.equal(focus.promptFrom([use('t', 'Agent', { prompt: 'go' })], live).kind, 'input', 'a running subagent is not itself the prompt');
  const none = focus.promptFrom([], live);
  assert.equal(none.kind, 'input');
  assert.equal(none.token, 'live:1000');
});

test('only the end of a long transcript is read, without a cut-off first line', () => {
  const file = path.join(fx.root, 'long.jsonl');
  fs.writeFileSync(file, `${'x'.repeat(900 * 1024)}\n${say('m1', use('end', 'Bash', { command: 'ls' }))}\n`);
  const lines = focus.tailLines(file);
  assert.ok(!lines[0].startsWith('xxx'), 'the partial line is dropped');
  assert.deepEqual(ids(focus.unanswered(lines)), ['end']);
});

test('which sessions come up, and in what order', () => {
  const now = 100 * 3600000;
  const s = (id, estate, hoursAgo, extra) => ({ id, estate, lastActivityAt: now - hoursAgo * 3600000, archived: false, live: '', routineId: null, hidden: false, waiting: null, ...extra });
  const sessions = [
    s('new-prompt', 'needs_you', 0, { live: 'waiting', waiting: { since: now - 1000 } }),
    s('old-prompt', 'needs_you', 1, { live: 'waiting', waiting: { since: now - 9000 } }),
    s('recent-ask', 'needs_you', 0.5),
    s('older-ask', 'needs_you', 1.5),
    s('hours-ago-ask', 'needs_you', 5),
    s('stale-ask', 'needs_you', 30),
    s('stale-but-open', 'needs_you', 30, { live: 'idle' }),
    s('archived', 'needs_you', 1, { archived: true }),
    s('old-run', 'needs_you', 1, { routineId: 'r' }),
    s('latest-run', 'running', 0, { routineId: 'r' }),
    s('running', 'running', 9),
    s('just-done', 'done', 1),
    s('long-done', 'done', 3),
    s('hidden', 'done', 1, { hidden: true }),
  ];
  const routines = new Map([['r', { latest: sessions.find((x) => x.id === 'latest-run') }]]);
  const f = focus.build(sessions, routines, now);
  assert.deepEqual(f.decide, ['old-prompt', 'new-prompt'], 'live prompts, longest waiting first');
  assert.deepEqual(f.reply, ['recent-ask', 'older-ask'], 'asked in the last two hours, newest first, even with its process still open');
  assert.deepEqual(f.active, ['latest-run', 'running', 'just-done']);
});

test('a session stopped on a prompt needs the user, and a new prompt undoes "handled"', () => {
  const id = fx.ids.child;
  const cli = fx.uuid(102);
  const transcript = path.join(path.dirname(fx.transcript), `${cli}.jsonl`);
  fs.writeFileSync(transcript, `${say('m1', use('q1', 'AskUserQuestion', question('Which one?')))}\n`);
  fs.writeFileSync(liveFile, JSON.stringify({ pid: process.pid, sessionId: cli, hostSessionId: id, cwd: '/work/app', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: Date.now() - 5000 }));
  const state = () => view.buildState(store.load(), claude.scan());
  const child = (st) => st.sessions.find((s) => s.id === id);

  let st = state();
  assert.equal(child(st).estate, 'needs_you', 'not "running"');
  assert.equal(child(st).waiting.kind, 'question');
  assert.equal(child(st).summary.needsAction, 'Which one?', 'Needs me and the menu bar show the real question');
  assert.deepEqual(st.focus.decide, [id]);

  store.apply('session.meta', { sessionIds: [id], ack: { [id]: child(st).token } });
  st = state();
  assert.equal(child(st).estate, 'idle');
  assert.deepEqual(st.focus.decide, []);

  fs.appendFileSync(transcript, `${answer('q1')}\n${say('m2', use('q2', 'AskUserQuestion', question('And this?')))}\n`);
  st = state();
  assert.equal(child(st).estate, 'needs_you', 'the next prompt comes back');
  assert.deepEqual(st.focus.decide, [id]);

  fs.writeFileSync(liveFile, JSON.stringify({ pid: process.pid, sessionId: cli, hostSessionId: id, cwd: '/work/app', status: 'busy' }));
  st = state();
  assert.equal(child(st).estate, 'running', 'answered: it goes back to work');
  assert.equal(child(st).waiting, null);
  assert.deepEqual(st.focus.decide, []);
  fs.rmSync(liveFile);
});
