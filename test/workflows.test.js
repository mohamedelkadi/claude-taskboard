'use strict';
// Workflows: saving them, when their schedules fire, and runs of a fake `claude`
// that streams what the real one does with --output-format stream-json.
const fx = require('./fixture');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The fake reads its prompt to decide how to behave, and records the arguments it got.
const fake = path.join(fx.root, 'fake-claude');
const argsFile = path.join(fx.root, 'fake-args.json');
fs.writeFileSync(
  fake,
  `#!${process.execPath}
const args = process.argv.slice(2);
require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY || '', nested: process.env.CLAUDECODE || '' }));
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', loginExpiresAt: '2099-01-01T00:00:00Z', email: 'someone@example.com' })); process.exit(0); }
const prompt = args[args.indexOf('-p') + 1];
const sid = args[args.indexOf('--session-id') + 1];
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\\n');
out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-test' });
if (prompt.includes('slow')) { setTimeout(() => {}, 60000); process.on('SIGTERM', () => process.exit(143)); return; }
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List files' } }] } });
out({ type: 'system', subtype: 'task_summary', detail: 'Listing files' });
if (prompt.includes('login')) { out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', total_cost_usd: 0 }); process.exit(1); }
if (prompt.includes('deny')) out({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Permission to use Bash has been denied because Claude Code is running in don\\'t ask mode.' }] } });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Found **3** files.', num_turns: 2, total_cost_usd: 0.12 });
`
);
fs.chmodSync(fake, 0o755);
process.env.TASKBOARD_CLAUDE_BIN = fake;
process.env.ANTHROPIC_API_KEY = 'sk-should-not-pass';
process.env.CLAUDECODE = '1';

const store = require('../src/store');
const workflows = require('../src/workflows');

after(() => fx.cleanup());

const folder = path.join(fx.root, 'work');
fs.mkdirSync(folder, { recursive: true });
const card = store.apply('card.create', { title: 'Nightly checks' });
const cardNow = () => store.load().cards.find((c) => c.id === card.id);

/** Wait until `fn` returns something truthy. */
async function until(fn, ms = 5000) {
  const t = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const finished = (runId) => until(() => {
  const r = cardNow().runs.find((x) => x.id === runId);
  return r && r.status !== 'running' && !workflows.running.has(runId) && r;
});

test('a workflow needs a name and a prompt, and its schedule is checked', () => {
  assert.throws(() => store.apply('workflow.save', { card: card.id, workflow: { prompt: 'x' } }), /name/);
  assert.throws(() => store.apply('workflow.save', { card: card.id, workflow: { name: 'x' } }), /what Claude should do/);
  assert.throws(() => store.apply('workflow.save', { card: card.id, workflow: { name: 'x', prompt: 'y', schedule: { kind: 'daily', at: '25:00' } } }), /HH:MM/);
  assert.throws(() => store.apply('workflow.save', { card: card.id, workflow: { name: 'x', prompt: 'y', folder: 'relative/dir' } }), /full path/);
  const wf = store.apply('workflow.save', { card: card.id, workflow: { name: 'Count', prompt: 'count the files', folder, access: 'nonsense', schedule: { kind: 'hourly', every: 99 } } });
  assert.equal(wf.access, 'read'); // anything unknown is the safe choice
  assert.equal(wf.schedule.every, 24);
  assert.equal(wf.timeoutMin, 30);
  assert.equal(wf.postNote, true);
  const again = store.apply('workflow.save', { card: card.id, workflow: { id: wf.id, name: 'Count files', prompt: 'count the files', folder, schedule: { kind: 'manual' } } });
  assert.equal(again.id, wf.id);
  assert.equal(cardNow().workflows.length, 1);
});

test('schedules fire at their next time, counted from the last one', () => {
  const day = new Date(2026, 10, 25, 8, 0).getTime(); // a Wednesday, 08:00
  const wf = { enabled: true, createdAt: day, scheduleFrom: day };
  assert.equal(workflows.nextRun({ ...wf, schedule: { kind: 'manual' } }), 0);
  assert.equal(workflows.nextRun({ ...wf, schedule: { kind: 'hourly', every: 3 } }), day + 3 * 3600e3);
  assert.equal(workflows.nextRun({ ...wf, schedule: { kind: 'daily', at: '09:30' } }), new Date(2026, 10, 25, 9, 30).getTime());
  assert.equal(workflows.nextRun({ ...wf, schedule: { kind: 'daily', at: '07:00' } }), new Date(2026, 10, 26, 7, 0).getTime());
  // Friday 18:00 → the next weekday is Monday
  const fri = new Date(2026, 10, 27, 18, 0).getTime();
  assert.equal(workflows.nextRun({ ...wf, scheduleFrom: fri, schedule: { kind: 'weekdays', at: '09:00' } }), new Date(2026, 10, 30, 9, 0).getTime());
  assert.equal(workflows.nextRun({ ...wf, schedule: { kind: 'weekly', day: 1, at: '09:00' } }), new Date(2026, 10, 30, 9, 0).getTime());
  assert.equal(workflows.nextRun({ ...wf, enabled: false, schedule: { kind: 'hourly', every: 1 } }), 0);
  assert.equal(workflows.describeSchedule({ kind: 'weekdays', at: '09:00' }), 'Weekdays at 09:00');
});

test('a run streams into the card, ends with its result as a note, and keeps its log', async () => {
  const wf = cardNow().workflows[0];
  const run = workflows.start(card.id, wf.id, 'manual');
  assert.equal(run.status, 'running');
  assert.throws(() => workflows.start(card.id, wf.id, 'manual'), /already running/);
  const done = await finished(run.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result, 'Found **3** files.');
  assert.equal(done.cost, 0.12);
  assert.equal(done.tools, 1);

  const got = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.equal(got.cwd, fs.realpathSync(folder));
  assert.equal(got.apiKey, '', 'a run never gets an API key: it uses the Claude login');
  assert.equal(got.nested, '', 'nor the variables of the Claude session that started the board');
  assert.deepEqual(got.args.slice(0, 2), ['-p', 'count the files']);
  assert.ok(got.args.includes('--session-id') && got.args.includes(run.sessionId));
  assert.equal(got.args[got.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(got.args[got.args.indexOf('--permission-prompts') + 1], 'none');

  const b = store.load();
  assert.equal(b.sessionMeta[run.sessionId].hidden, true, 'its session stays out of Unsorted');
  const note = cardNow().notes.at(-1);
  assert.equal(note.by, 'workflow · Count files');
  assert.match(note.text, /Found \*\*3\*\* files/);

  const log = workflows.readLog(run.id);
  assert.deepEqual(log.map((e) => e.kind), ['status', 'tool', 'status', 'text', 'result']);
  assert.equal(log[1].text, 'Bash: List files');
});

test('what it may not do is counted and shown as skipped, not as an error', async () => {
  const wf = store.apply('workflow.save', { card: card.id, workflow: { name: 'Denied', prompt: 'deny a command', folder, postNote: false } });
  const done = await finished(workflows.start(card.id, wf.id, 'manual').id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.denied, 1);
  const denied = workflows.readLog(done.id).find((e) => e.kind === 'denied');
  assert.equal(denied.text, 'Not allowed to use Bash here, so it was skipped.');
  const got = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.ok(got.args.includes('mcp__taskboard__board_get_card'), 'a run may always read its card');
});

test('a run that is not logged in says how to fix it', async () => {
  const wf = store.apply('workflow.save', { card: card.id, workflow: { name: 'Needs login', prompt: 'login please', folder } });
  const done = await finished(workflows.start(card.id, wf.id, 'manual').id);
  assert.equal(done.status, 'failed');
  assert.match(done.hint, /\/login/);
  assert.match(cardNow().notes.at(-1).text, /failed/);
});

test('a run can be stopped, and one the board lost track of is marked interrupted', async () => {
  const wf = store.apply('workflow.save', { card: card.id, workflow: { name: 'Slow', prompt: 'be slow', folder, postNote: false } });
  const notes = cardNow().notes.length;
  const run = workflows.start(card.id, wf.id, 'manual');
  await until(() => fs.existsSync(path.join(fx.root, 'data', 'runs', `${run.id}.jsonl`)) && fs.statSync(path.join(fx.root, 'data', 'runs', `${run.id}.jsonl`)).size > 0);
  assert.equal(workflows.stop(run.id), true);
  const done = await finished(run.id);
  assert.equal(done.status, 'stopped');
  assert.equal(cardNow().notes.length, notes, 'postNote off: nothing is added');

  store.mutate((b) => b.cards.find((c) => c.id === card.id).runs.push({ id: 'r_deadbeef', workflowId: wf.id, status: 'running', startedAt: Date.now() }));
  workflows.settleOrphans();
  assert.equal(cardNow().runs.find((r) => r.id === 'r_deadbeef').status, 'interrupted');
});

test('the scheduler starts what is due once, and a folder that is gone fails clearly', async () => {
  const wf = store.apply('workflow.save', { card: card.id, workflow: { name: 'Hourly', prompt: 'count the files', folder, schedule: { kind: 'hourly', every: 1 }, postNote: false } });
  store.mutate((b) => (b.cards.find((c) => c.id === card.id).workflows.find((w) => w.id === wf.id).scheduleFrom = Date.now() - 2 * 3600e3));
  workflows.tick({ cards: [cardNow()] });
  const runs = cardNow().runs.filter((r) => r.workflowId === wf.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'schedule');
  workflows.tick({ cards: [cardNow()] }); // while it runs, and after: not again for an hour
  await finished(runs[0].id);
  workflows.tick({ cards: [cardNow()] });
  assert.equal(cardNow().runs.filter((r) => r.workflowId === wf.id).length, 1);
  assert.ok(workflows.nextRun(cardNow().workflows.find((w) => w.id === wf.id)) > Date.now() + 3500e3);

  const gone = store.apply('workflow.save', { card: card.id, workflow: { name: 'Gone', prompt: 'x', folder: path.join(fx.root, 'nope') } });
  assert.throws(() => workflows.start(card.id, gone.id, 'manual'), /does not exist/);
  const noFolder = store.apply('workflow.save', { card: card.id, workflow: { name: 'Nowhere', prompt: 'x' } });
  assert.throws(() => workflows.start(card.id, noFolder.id, 'manual'), /No folder/);
  assert.equal(workflows.start(card.id, noFolder.id, 'manual', folder).cwd, folder, "it falls back to the card's folder");
  await until(() => !workflows.running.size);
});

test('Claude can see whether it is logged in, without the email address', async () => {
  const a = await workflows.check();
  assert.equal(a.loggedIn, true);
  assert.equal(a.plan, 'max');
  assert.equal(a.email, undefined);
});

test('deleting a workflow removes its runs and their logs', () => {
  const wf = cardNow().workflows.find((w) => w.name === 'Count files');
  const ids = cardNow().runs.filter((r) => r.workflowId === wf.id).map((r) => r.id);
  assert.ok(ids.length);
  store.apply('workflow.remove', { card: card.id, workflow: 'Count files' });
  assert.equal(cardNow().runs.filter((r) => r.workflowId === wf.id).length, 0);
  for (const id of ids) assert.equal(fs.existsSync(path.join(fx.root, 'data', 'runs', `${id}.jsonl`)), false);
});
