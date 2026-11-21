'use strict';
// The diary: short dated notes per day, kept after Claude's own files are gone.
const fx = require('./fixture');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/paths');
const store = require('../src/store');
const claude = require('../src/claude');
const view = require('../src/view');
let diary = require('../src/diary');

after(fx.cleanup);

const state = () => view.buildState(store.load(), claude.scan());
// a time on the local day `daysAgo` days back; the fixture's own sessions are all within the last hour
const at = (daysAgo, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const D3 = diary.dayOf(at(3, 12, 0));
const D2 = diary.dayOf(at(2, 12, 0));
const iso = (ms) => new Date(ms).toISOString();
const OLD = fx.uuid(106); // the transcript of the fixture's archived session
const transcript = path.join(P.PROJECTS_DIR, '-work-app', `${OLD}.jsonl`);
const record = path.join(fx.sessDir, `${fx.ids.old}.json`);

const user = (ms, content, extra) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', timestamp: iso(ms), cwd: '/work/app', gitBranch: 'export-speed', origin: { kind: 'human' }, message: { role: 'user', content }, ...extra });
const tool = (ms, id, name, input) => JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const says = (ms, text) => JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const queued = (ms, prompt, commandMode) => JSON.stringify({ parentUuid: 'p', isSidechain: false, attachment: { type: 'queued_command', prompt, commandMode, timestamp: iso(ms) }, type: 'attachment', timestamp: iso(ms) });
const prLink = (ms) => JSON.stringify({ type: 'pr-link', sessionId: OLD, prNumber: 12, prUrl: 'https://github.com/acme/app/pull/12', prRepository: 'acme/app', timestamp: iso(ms) });

fs.writeFileSync(transcript, [
  // three days ago: asked, planned, edited, committed, opened a PR, answered
  user(at(3, 9, 0), [{ type: 'text', text: '<system-reminder>ignore me</system-reminder>\nMake the order export faster for big shops. ' + 'Details. '.repeat(700) }]),
  JSON.stringify({ type: 'user', isSidechain: false, timestamp: iso(at(3, 9, 1)), message: { role: 'user', content: [{ tool_use_id: 'x', type: 'tool_result', content: 'git commit -m "not a commit, just tool output"' }] }, toolUseResult: { stdout: 'x' } }),
  tool(at(3, 9, 2), 'a1', 'mcp__ccd_turn__update_plan', { items: [{ content: 'Profile it', status: 'in_progress' }, { content: 'Fix the query', status: 'pending' }] }),
  tool(at(3, 9, 10), 'a2', 'Edit', { file_path: '/work/app/app/export.rb', old_string: 'a', new_string: 'b' }),
  tool(at(3, 9, 11), 'a3', 'Edit', { file_path: '/work/app/app/export.rb', old_string: 'b', new_string: 'c' }),
  tool(at(3, 9, 20), 'a4', 'mcp__ccd_turn__update_plan', { advance: true }),
  tool(at(3, 9, 30), 'a5', 'Bash', { command: 'git add -A && git commit -m "$(cat <<\'EOF\'\nLoad line items in one query\n\nLonger body.\nEOF\n)"' }),
  prLink(at(3, 9, 31)),
  prLink(at(3, 9, 40)), // Claude writes the link again on later turns
  says(at(3, 9, 32), 'Working on it.'),
  says(at(3, 9, 45), 'It was loading every line item one by one. One query now: 40 s down to 3 s.'),
  // two days ago: a second prompt, one typed while Claude was busy, noise, and a turn that ends in a recap
  user(at(2, 10, 0), 'Now add a progress bar to the export page'),
  queued(at(2, 10, 5), 'also keep the old CSV columns', 'prompt'),
  queued(at(2, 10, 6), '<task-notification>a background task finished</task-notification>', 'task-notification'),
  user(at(2, 10, 7), 'injected by the app', { isMeta: true }),
  user(at(2, 10, 8), 'a scheduled run', { origin: { kind: 'task-notification' } }),
  user(at(2, 10, 9), '<command-name>/compact</command-name>'),
  tool(at(2, 10, 30), 'b1', 'mcp__ccd_turn__wrap_up', { recap: 'The export page shows a progress bar and keeps the old columns.' }),
  says(at(2, 10, 31), 'Done: the progress bar is in.'),
].join('\n') + '\n');

const page = (opts) => diary.page(opts || {}, state());
const old = (p) => p.day.sessions.find((s) => s.title === 'Archived thing');

test('a day lists what was asked, done, committed and answered, in short', async () => {
  diary.sync(state());
  await diary.crawl();
  const p = page({ day: D3 });
  const s = old(p);
  assert.ok(s, 'an archived session is in the diary like any other');
  assert.equal(s.archived, true);
  assert.equal(s.exists, true);
  assert.deepEqual(s.entries.map((e) => e.k), ['p', 'f', 's', 'c', 'pr', 'a']);
  const [asked, file, step, commit, pr, answer] = s.entries;
  assert.match(asked.x, /^Make the order export faster/, 'the app\'s own blocks around a prompt are dropped');
  assert.ok(asked.x.length <= diary.MAX.p, 'a long prompt is kept as its beginning, not in full');
  assert.equal(step.x, 'Profile it');
  assert.equal(file.x, 'app/export.rb', 'a file edited twice is listed once, by its path in the project');
  assert.equal(commit.x, 'Load line items in one query');
  assert.deepEqual([pr.n, pr.repo, pr.url], [12, 'acme/app', 'https://github.com/acme/app/pull/12']);
  assert.match(answer.x, /^It was loading every line item/, 'Claude\'s last words of the turn, not the ones in between');
  assert.deepEqual(p.day.totals.projects, ['app']);
  assert.equal(p.day.next, D2);

  const next = old(page({ day: D2 }));
  assert.deepEqual(next.entries.map((e) => [e.k, e.x]), [
    ['p', 'Now add a progress bar to the export page'],
    ['p', 'also keep the old CSV columns'],
    ['s', 'Fix the query'], // wrapping up a turn finishes the step that was in progress
    ['r', 'The export page shows a progress bar and keeps the old columns.'],
  ], 'noise is left out, and a turn with a recap keeps the recap only');

  const days = new Map(p.days.map((d) => [d[0], d]));
  assert.deepEqual(days.get(D3), [D3, 1, 1]);
  assert.deepEqual(days.get(D2), [D2, 1, 2]);
  assert.equal(page().day.day, diary.dayOf(Date.now()), 'with no day asked for, the latest one with something in it');
});

test('search finds a day by what was said, with plurals, and by project', () => {
  const find = (q, project) => page({ q, project }).results;
  const r = find('line items');
  assert.equal(r.total, 1);
  assert.equal(r.items[0].day, D3);
  assert.equal(r.items[0].title, 'Archived thing');
  assert.ok(r.items[0].hits.some((e) => e.k === 'c'));
  assert.equal(find('exports items').total, 1, '"exports" finds "export"');
  assert.deepEqual(find('queries').days.map((d) => d[0]), [D2, D3], '"queries" finds "query"');
  assert.deepEqual(find('"progress bar" csv').items.map((i) => i.day), [D2], 'words may be in different entries of the same day');
  assert.equal(find('"bar progress"').total, 0, 'a quoted phrase has to appear as written');
  assert.deepEqual(find('archived thing').days.map((d) => d[0]), [D2, D3], 'a session is also found by its title');
  assert.equal(find('progress', 'somewhere-else').total, 0);
  assert.equal(find('progress', 'app').total, 1);
});

test('a note for a day is kept with it and searchable', () => {
  const far = diary.dayOf(at(40, 12, 0));
  store.apply('diary.note', { day: far, text: 'Decided to drop the legacy exporter.' });
  store.apply('diary.note', { day: far, text: 'Told the shops team.', append: true });
  diary.setNotes(store.load().dayNotes);
  const p = page({ day: far });
  assert.equal(p.day.note, 'Decided to drop the legacy exporter.\nTold the shops team.');
  assert.ok(p.days.some((d) => d[0] === far), 'a day with only a note is still a day');
  assert.equal(page({ q: 'legacy exporter' }).results.items[0].day, far);
  assert.throws(() => store.apply('diary.note', { day: 'tomorrow', text: 'x' }), /YYYY-MM-DD/);
  store.apply('diary.note', { day: far, text: '' });
  diary.setNotes(store.load().dayNotes);
  assert.equal(page({ day: far }).day.note, '');
});

test('a transcript is read once, and reading it again adds nothing', async () => {
  const file = path.join(diary.DAYS_DIR, `${D3}.json`);
  const before = fs.readFileSync(file, 'utf8');
  assert.ok(before.length < 1500, 'a day of one session is a small file');

  // only what was appended is read
  fs.appendFileSync(transcript, user(at(2, 11, 0), 'And a cancel button') + '\n');
  await diary.crawl();
  assert.deepEqual(old(page({ day: D2 })).entries.map((e) => e.k), ['p', 'p', 's', 'r', 'p']);

  // the reading positions are a cache: without them everything is read again, and nothing is doubled
  fs.rmSync(path.join(P.CACHE_DIR, 'diary'), { recursive: true, force: true });
  delete require.cache[require.resolve('../src/diary')];
  diary = require('../src/diary');
  diary.sync(state());
  await diary.crawl();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(old(page({ day: D2 })).entries.length, 5);
});

test('the diary keeps a day after Claude deletes the session and its transcript', async () => {
  fs.rmSync(transcript);
  fs.rmSync(record);
  const st = state();
  assert.ok(!st.sessions.some((s) => s.id === fx.ids.old), 'Claude no longer has it');
  diary.sync(st);
  await diary.crawl();
  const s = old(diary.page({ day: D3 }, st));
  assert.ok(s, 'the day is still there');
  assert.equal(s.exists, false);
  assert.equal(s.title, 'Archived thing', 'under the title the session had');
  assert.equal(diary.titleOf(fx.ids.old), 'Archived thing', 'which a card that still lists the session can show');
  assert.equal(s.entries.length, 6);
  assert.equal(diary.page({ q: 'line items' }, st).results.total, 1, 'and still found by search');
  assert.ok(!fs.existsSync(path.join(P.CACHE_DIR, 'diary', `${OLD}.json`)), 'its reading position is dropped with the transcript');
});

test('the text form for Claude and the terminal', () => {
  const st = state();
  const text = diary.markdown({ day: D3 }, st);
  assert.match(text, /^# .+ \(\d{4}-\d{2}-\d{2}\)\n1 session · 1 prompt · 1 commit · 1 PR/);
  assert.match(text, /09:00 asked: Make the order export faster/);
  assert.match(text, /09:30 commit: Load line items in one query/);
  assert.match(text, /no longer in Claude/);
  assert.match(text, /files: export\.rb/);
  assert.match(diary.markdown({ q: 'progress bar' }, st), /1 match for "progress bar" on 1 day/);
  assert.match(diary.markdown({ q: 'nothing like this' }, st), /Nothing in the diary matches/);
  assert.match(diary.markdown({ day: D2, days: 2 }, st), new RegExp(`\\(${D2}\\)[\\s\\S]+\\(${D3}\\)`), 'a span of days, newest first');
});

test('commit subjects are read from the usual ways of writing git commit', () => {
  assert.equal(diary.commitMessage('git commit -m "Fix the export"'), 'Fix the export');
  assert.equal(diary.commitMessage("git -C /work/app commit -am 'One query, not many'"), 'One query, not many');
  assert.equal(diary.commitMessage('git add . && git commit -m "Say \\"hi\\" once" && git push'), 'Say "hi" once');
  assert.equal(diary.commitMessage('git commit --amend --no-edit'), '');
  assert.equal(diary.commitMessage('echo "then run git commit -m nope"'), '', 'the words in an argument are not a commit');
  assert.equal(diary.commitMessage("cat > notes.sh <<'EOF'\ncd repo && git commit -m \"Not run\"\nEOF"), '', 'nor is a script being written to a file');
});
