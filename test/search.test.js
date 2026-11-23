'use strict';
// Searching inside conversations: what goes in, what stays out, and what a search finds.
const fx = require('./fixture');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const search = require('../src/search');
const claude = require('../src/claude');
const store = require('../src/store');
const view = require('../src/view');

after(() => fx.cleanup());

const skip = !search.available() && 'needs node:sqlite';
const dir = path.dirname(fx.transcript);
const file = (n) => path.join(dir, `${fx.uuid(n)}.jsonl`);
const when = (n) => new Date(Date.now() - 3000e3 + n * 1000).toISOString();
const user = (text, n = 0) => JSON.stringify({ type: 'user', isSidechain: false, cwd: '/work/app', timestamp: when(n), message: { role: 'user', content: text } });
const reply = (text, n = 1) => JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: when(n), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const write = (n, lines) => fs.writeFileSync(file(n), lines.join('\n') + '\n');
const append = (n, lines) => fs.appendFileSync(file(n), lines.join('\n') + '\n');

function state() {
  const scan = claude.scan();
  if (!store.exists()) view.seed(scan);
  return view.buildState(store.load(), scan);
}
const find = (q, opts) => search.query(q, { state: state(), ...opts });
const ids = (q) => find(q).results.map((r) => r.id);
const stored = () => fs.readFileSync(search.DB_FILE);

test('credentials are taken out and the words around them stay', () => {
  const samples = {
    'password=hunter2hunter': 'password=[redacted]',
    'DB_PASSWORD: "s3cretvalue99"': 'DB_PASSWORD: "[redacted]"',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz': 'Authorization: Bearer [redacted]',
    'postgres://admin:pa55word@db.internal/app': 'postgres://admin:[redacted]@db.internal/app',
    'use sk-abcdefghijklmnopqrstuvwxyz123 here': 'use [redacted] here',
    'token ghp_abcdefghijklmnopqrstuvwxyz1234': 'token [redacted]',
    'key AKIAIOSFODNN7EXAMPLE end': 'key [redacted] end',
    'jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abc123 end': 'jwt [redacted] end',
    '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- after': '[redacted] after',
  };
  for (const [from, to] of Object.entries(samples)) assert.equal(search.redact(from), to);
  assert.equal(search.redact('the task-runner token budget is fine'), 'the task-runner token budget is fine');
});

test('prompts, replies and commands are indexed; reminders, tool output and subagents are not', { skip }, async () => {
  write(102, [
    user('<system-reminder>hiddenreminderword</system-reminder>the courier payout report is wrong for october'),
    reply('The settlement total skips refunded deliveries. Connect with password=correcthorsebattery'),
    JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: when(2), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rg ledgerquirk app/models/payout.rb' } }] } }),
    JSON.stringify({ type: 'user', isSidechain: false, timestamp: when(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'toolonlyoutputword' }] }, toolUseResult: { stdout: 'toolonlyoutputword' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: when(4), message: { role: 'assistant', content: [{ type: 'text', text: 'sidechainonlyword' }] } }),
    reply('The settlement total skips refunded deliveries. Connect with password=correcthorsebattery', 5), // logged twice
  ]);
  await search.update();

  assert.deepEqual(ids('october payout'), [fx.ids.child], 'a prompt');
  assert.deepEqual(ids('refunded settlement'), [fx.ids.child], 'a reply');
  assert.deepEqual(ids('ledgerquirk'), [fx.ids.child], 'a command');
  for (const word of ['hiddenreminderword', 'toolonlyoutputword', 'sidechainonlyword']) assert.deepEqual(ids(word), [], word);

  const hit = find('refunded').results[0];
  assert.equal(hit.title, 'Child of root', 'shown as the board knows it');
  assert.equal(hit.hits.length, 1, 'text logged twice is kept once');
  assert.equal(hit.hits[0].kind, 'answer');
  assert.match(hit.hits[0].text, /\u0001refunded\u0002/);
  assert.ok(!stored().includes('correcthorsebattery'), 'the password never reaches the file');
});

test('links and keys find the session behind them; a quoted phrase has to appear', { skip }, async () => {
  write(103, [user('please look at https://github.com/acme/app/pull/4242 and SHOP-881'), reply('the voucher stacking rule lives in the checkout service')]);
  await search.update();
  assert.deepEqual(ids('https://github.com/acme/app/pull/4242/files'), [fx.ids.other]);
  assert.deepEqual(ids('SHOP-881'), [fx.ids.other]);
  assert.deepEqual(ids('https://acme.atlassian.net/browse/SHOP-881'), [fx.ids.other]);
  assert.deepEqual(ids('"voucher stacking"'), [fx.ids.other]);
  assert.deepEqual(ids('"stacking voucher"'), []);
  assert.deepEqual(search.parseQuery('the "exact words" and order').required, ['exact words']);
  assert.deepEqual(search.parseQuery('the "exact words" and order').terms, ['order']);
  assert.deepEqual(search.parseQuery('what is the').terms, ['what', 'is', 'the'], 'only small words: search for them anyway');
});

test('a misspelled word also finds the word it was meant to be', { skip }, async () => {
  for (const n of [120, 121, 122]) write(n, [user(`draw a sequence diagram for service ${n}`), reply('here is the diagram')]);
  await search.update();
  const r = find('digram');
  assert.deepEqual(r.corrected, [{ from: 'digram', to: 'diagram' }]);
  assert.equal(r.total, 3);

  const words = new Map([['order', 900], ['older', 60], ['coupons', 50], ['coupon', 400], ['manger', 4], ['manager', 90]]);
  assert.deepEqual(search.corrections(['older'], words), [], 'a common word is left alone');
  assert.deepEqual(search.corrections(['coupons'], words), [], 'a plural is not a typo');
  assert.deepEqual(search.corrections(['manger'], words), [{ from: 'manger', to: 'manager' }]);
  assert.deepEqual(search.corrections(['automation'], new Map([['automation', 25], ['automatic', 40]])), [], 'a real word near another real word');
  assert.deepEqual(search.corrections(['conflance'], new Map([['conflance', 6], ['confluence', 34]])), [{ from: 'conflance', to: 'confluence' }]);
});

test('only what was added is read again, and a later title reaches earlier text', { skip }, async () => {
  write(130, [user('tuning the warehouse picker')]);
  assert.equal((await search.update()).indexed, 1);
  assert.equal((await search.update()).indexed, 0, 'nothing changed');
  append(130, [reply('the picker now batches aisles', 9), JSON.stringify({ type: 'ai-title', aiTitle: 'Zebrafinch optimisation' })]);
  assert.equal((await search.update()).indexed, 1);
  const r = find('aisles');
  assert.equal(r.total, 1);
  assert.equal(r.results[0].exists, true, 'a transcript with no desktop record is still a session');
  assert.equal(find('zebrafinch warehouse').total, 1);
  assert.deepEqual(find('zebrafinch').results[0].hits, [], 'found by its title: no passage is passed off as a match');
  const both = find('zebrafinch aisles').results[0].hits;
  assert.equal(both.length, 1);
  assert.match(both[0].text, /\u0001aisles\u0002/, 'the passage shown is one with the word in it');
});

test('when Claude deletes a transcript its text leaves the index', { skip }, async () => {
  write(140, [user('the vanishingword should not outlive this session')]);
  await search.update();
  assert.equal(find('vanishingword').total, 1);
  assert.ok(stored().includes('vanishingword'));
  fs.rmSync(file(140));
  assert.equal((await search.update()).removed, 1);
  assert.equal(find('vanishingword').total, 0);
  assert.ok(!stored().includes('vanishingword'), 'gone from the file, not only from results');
});

test('a damaged index is rebuilt from the transcripts', { skip }, async () => {
  for (const suffix of ['-wal', '-shm']) fs.rmSync(search.DB_FILE + suffix, { force: true });
  fs.writeFileSync(search.DB_FILE, 'this is not a database, and it is long enough to be read as a header by SQLite');
  assert.equal(find('refunded').total, 0, 'searching a damaged index finds nothing rather than failing');
  await search.update();
  assert.equal(find('refunded').total, 1);
});

test('the text answer for Claude and the terminal', { skip }, async () => {
  const text = search.markdown({ q: 'refunded settlement' }, state());
  assert.match(text, /1 session match/);
  assert.match(text, /\*\*Child of root\*\*/);
  assert.match(text, /Claude: .*\*\*refunded\*\*/);
  assert.doesNotMatch(text, /[\u0001\u0002]/);
  assert.match(search.markdown({ q: 'nothingmatchesthisword' }, state()), /No conversation matches/);
  assert.equal(search.query('refunded', { state: state(), project: 'some-other-project' }).total, 0);
  assert.equal(search.query('refunded', { state: state(), project: 'app' }).total, 1);
});
