#!/usr/bin/env node
'use strict';
// Taskboard on made-up data, for trying it out or taking screenshots.
//
// Builds a fake copy of Claude's folders in a temp directory (a fictional
// web-shop project with a dozen sessions), puts a board over it and serves it
// on its own port. Nothing under your real ~/.claude or the Claude app's
// folder is read or written, and "Open in Claude" does nothing here.
//
//   node scripts/demo.js        → http://127.0.0.1:4781/
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-demo-'));
const claudeDir = path.join(root, 'claude');
const desktopDir = path.join(root, 'desktop');
process.env.TASKBOARD_CLAUDE_DIR = claudeDir;
process.env.TASKBOARD_DESKTOP_DIR = desktopDir;
process.env.TASKBOARD_DATA_DIR = path.join(root, 'data');
process.env.TASKBOARD_PORT = process.env.TASKBOARD_DEMO_PORT || '4781';
process.env.TASKBOARD_NO_OPEN = '1';
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const sessDir = path.join(desktopDir, 'claude-code-sessions', 'acct', 'org');
const liveDir = path.join(claudeDir, 'sessions');
fs.mkdirSync(sessDir, { recursive: true });
fs.mkdirSync(liveDir, { recursive: true });

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sid = (n) => `local_${uuid(n)}`;
const NOW = Date.now();
const MIN = 60e3;
const pr = (repo, number, state, branch) => ({ prNumber: number, repo, url: `https://github.com/${repo}/pull/${number}`, state, branch });

// state: running | needs | review | done | idle
function session(n, s) {
  const cwd = s.cwd || '/work/shop-api';
  const last = NOW - (s.ago || 0) * MIN;
  const summary = {
    needs: { status_category: 'blocked', status_detail: s.detail || 'Waiting on a decision.', needs_action: s.ask, summarizes_uuid: `u-${n}` },
    review: { status_category: 'review_ready', status_detail: s.detail || 'Ready for a look.', needs_action: '' },
    done: { status_category: 'completed', status_detail: s.detail || 'Done.', needs_action: '' },
  }[s.state];
  const record = {
    sessionId: sid(n), cliSessionId: uuid(100 + n), cwd, originCwd: cwd, title: s.title,
    createdAt: last - (s.length || 50) * MIN, lastActivityAt: last, isArchived: !!s.archived,
    model: 'claude-sonnet-5-5', completedTurns: s.turns || 4, branch: s.branch || '',
    ...(summary ? { postTurnSummary: summary } : {}),
    ...(s.prs ? { prs: s.prs } : {}),
    ...(s.from ? { spawnedFrom: { sessionId: sid(s.from) } } : {}),
    ...(s.routine ? { scheduledTaskId: s.routine } : {}),
  };
  fs.writeFileSync(path.join(sessDir, `${sid(n)}.json`), JSON.stringify(record));

  // the transcript: first prompt, the step list as it advanced, the closing recap
  const projDir = path.join(claudeDir, 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const at = new Date(last).toISOString();
  const call = (id, name, input) => JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}-${id}`, name, input }] } });
  const lines = [JSON.stringify({ type: 'user', isSidechain: false, cwd, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: s.prompt || s.title }] } })];
  if (s.steps) {
    const doing = s.state === 'running' || s.state === 'needs' ? s.at ?? s.steps.length - 1 : s.steps.length;
    lines.push(call(1, 'mcp__ccd_turn__update_plan', { items: s.steps.map((content, i) => ({ content, status: i < doing ? 'completed' : i === doing ? 'in_progress' : 'pending' })) }));
  }
  if (s.recap) lines.push(call(2, 'mcp__ccd_turn__wrap_up', { recap: s.recap, ask: s.ask || '' }));
  if (s.cost) lines.push(JSON.stringify({ type: 'cost-state', totalCostUSD: s.cost }));
  fs.writeFileSync(path.join(projDir, `${uuid(100 + n)}.jsonl`), lines.join('\n') + '\n');

  // a running session is one with a live process; this demo's own will do
  if (s.state === 'running') {
    fs.writeFileSync(path.join(liveDir, `${n}.json`), JSON.stringify({ pid: process.pid, status: 'busy', sessionId: uuid(100 + n), hostSessionId: sid(n), cwd, name: s.title }));
  }
}

const API = '/work/shop-api';
const WEB = '/work/shop-web';
const INFRA = '/work/infra';

// Saved cards
session(1, {
  title: 'SHOP-212 saved cards API', cwd: API, state: 'review', ago: 38, branch: 'shop-212/saved-cards', cost: 3.42,
  prs: [pr('acme/shop-api', 481, 'OPEN', 'shop-212/saved-cards')],
  prompt: "Add endpoints to save, list and delete a customer's cards. Follow the payments service conventions and keep card numbers out of our database.",
  steps: ['Read the payments service', 'Add the payment_methods model', 'Add save, list and delete endpoints', 'Write request specs', 'Open the PR'],
  detail: 'Endpoints and specs are in; the PR is open.',
  recap: 'The three endpoints are in with request specs, and PR 481 is open. Card numbers never reach our database: only the provider token is stored.',
});
session(2, {
  title: 'SHOP-212 card picker UI', cwd: WEB, state: 'running', ago: 0, from: 1, branch: 'shop-212/card-picker', cost: 1.87,
  prs: [pr('acme/shop-web', 233, 'OPEN', 'shop-212/card-picker')],
  prompt: 'Build the card picker for checkout on top of the new saved-cards endpoints.',
  steps: ['Read the checkout form', 'Build the card list component', 'Wire it to the saved-cards API', 'Handle an expired card', 'Add component tests'], at: 2,
});
session(3, {
  title: 'Migration for payment_methods', cwd: API, state: 'needs', ago: 12, from: 1, cost: 0.94,
  ask: 'Drop the legacy cards column now, or keep it for one more release?',
  detail: 'The migration is written; one decision is open.',
  prompt: 'Write the migration for the payment_methods table and backfill it from the legacy column.',
  steps: ['Write the migration', 'Backfill from the legacy column', 'Test on a copy of staging', 'Remove the legacy column'], at: 3,
  recap: 'The migration and backfill ran cleanly on a copy of staging. The legacy column is still there.',
});

// Search
session(4, {
  title: 'SHOP-198 typo tolerance experiment', cwd: API, state: 'done', ago: 190, cost: 5.1,
  prs: [pr('acme/shop-api', 467, 'MERGED', 'shop-198/fuzzy')],
  prompt: 'People search "sneekers" and get nothing. Try fuzzy matching and measure it.',
  steps: ['Collect zero-result queries', 'Add fuzzy matching behind a flag', 'Measure recall on the replay set'],
  detail: 'Fuzzy matching lifts recall 6% on the replay set.',
  recap: 'Fuzzy matching at edit distance 1 lifts recall 6% on the replay set with no change to the top three results for exact queries.',
});
session(5, {
  title: "Replay last week's queries on the new index", cwd: API, state: 'needs', ago: 55, from: 4, cost: 2.2,
  ask: 'Pick the fuzziness threshold: 0.6 keeps more results, 0.7 is stricter.',
  detail: 'Replay finished for both thresholds.',
  steps: ['Export last week of queries', 'Replay at 0.6 and 0.7', 'Compare clicks on the top result'],
  recap: 'Both thresholds are replayed. 0.6 answers 4% more queries; 0.7 has slightly better top-result clicks.',
});

// Flaky tests (touches the same PR as the card picker)
session(6, {
  title: 'Flaky checkout e2e: find the race', cwd: WEB, state: 'needs', ago: 140, cost: 1.3,
  prs: [pr('acme/shop-web', 233, 'OPEN', 'shop-212/card-picker')],
  ask: 'The fix needs a wait for the payment iframe in the test helper. OK to add it?',
  detail: 'Found the race; a fix is ready.',
  steps: ['Reproduce the failure locally', 'Find the race', 'Fix the test helper'], at: 2,
  recap: 'The test clicks Pay before the payment iframe has loaded. Waiting for the iframe fixes 50 of 50 local runs.',
});

// Node upgrade
session(7, {
  title: 'Upgrade to Node 22', cwd: INFRA, state: 'review', ago: 300, cost: 2.75,
  prs: [pr('acme/infra', 75, 'OPEN', 'node-22')],
  steps: ['Bump the runtime', 'Fix the deprecations', 'Run the full suite'],
  detail: 'All green on Node 22; the PR is open.',
  recap: 'Everything passes on Node 22 and PR 75 is open. Two deprecation warnings are left in a dependency.',
});
session(8, { title: 'Node 22: fix the CI image', cwd: INFRA, state: 'done', ago: 420, from: 7, detail: 'CI image rebuilt on Node 22.', steps: ['Update the Dockerfile', 'Rebuild and push the image'] });

// A scheduled task: three runs
session(9, { title: 'Weekly dependency audit', cwd: INFRA, state: 'done', ago: 60 * 24 * 14, routine: 'dep-audit', detail: 'No advisories.' });
session(10, { title: 'Weekly dependency audit', cwd: INFRA, state: 'done', ago: 60 * 24 * 7, routine: 'dep-audit', detail: 'One advisory, patched.' });
session(11, { title: 'Weekly dependency audit', cwd: INFRA, state: 'done', ago: 75, routine: 'dep-audit', detail: 'No advisories; two minor updates available.', steps: ['Run the audit', 'Check for updates', 'Write the summary'] });

// Finished work
session(12, { title: 'Onboarding email copy', cwd: WEB, state: 'done', ago: 60 * 24 * 3, archived: true, detail: 'Three emails rewritten.' });
session(13, { title: 'Onboarding emails: subject line test', cwd: WEB, state: 'done', ago: 60 * 24 * 2, detail: 'Variant B wins on opens.' });

// Not on a card yet
session(14, { title: 'Explain the cart reducer', cwd: WEB, state: 'idle', ago: 25 });
session(15, { title: 'Try Bun for the test runner', cwd: WEB, state: 'done', ago: 95, detail: 'Bun runs the suite in 41 s instead of 2 min 10 s; three tests need changes.' });
session(16, { title: 'SHOP-198 synonyms list', cwd: API, state: 'review', ago: 110, detail: '140 synonym pairs drafted for review.' });
session(17, { title: 'Draft the Q4 planning doc', cwd: '/tmp/scratch-workspaces/q4', state: 'needs', ago: 18, ask: 'Which three goals go in the summary?', detail: 'Draft is ready apart from the summary.' });

// two groups in Claude's sidebar
fs.writeFileSync(
  path.join(desktopDir, 'claude_desktop_config.json'),
  JSON.stringify({
    preferences: { epitaxyPrefs: { 'dframe-group-scopes': { 'acct/org': {
      groups: [{ id: 'cg-checkout', name: 'Checkout' }, { id: 'cg-search', name: 'Search' }],
      assignments: { [`code:${sid(1)}`]: 'cg-checkout', [`code:${sid(2)}`]: 'cg-checkout', [`code:${sid(3)}`]: 'cg-checkout', [`code:${sid(4)}`]: 'cg-search', [`code:${sid(5)}`]: 'cg-search' },
    } } } },
  })
);

// ---------- the board ----------
const store = require('../src/store');
const op = (name, args) => store.apply(name, args);
const day = (n) => new Date(NOW + n * 864e5).toISOString().slice(0, 10);

op('card.create', { title: 'Docs: self-hosting guide', status: 'Backlog', priority: 'low', project: 'shop', tags: ['docs'] });
op('card.create', { title: 'Rate-limit the public API', status: 'Backlog', priority: 'high', project: 'shop', tags: ['api'], due: day(21) });
const sdk = op('card.create', {
  title: 'Payments SDK v4 upgrade', status: 'To do', priority: 'high', project: 'shop', ticket: 'SHOP-220',
  subtasks: ['Read the v4 migration guide', 'Upgrade in a branch', 'Run the payment smoke tests'],
});
op('card.create', { title: 'Dark mode for the storefront', status: 'To do', project: 'shop', tags: ['design'], subtasks: ['Audit hard-coded colours', 'Add the theme switch'] });

const goal = op('card.create', {
  title: 'Q4: lift checkout conversion', status: 'In progress', priority: 'high', project: 'shop', tags: ['goal'],
  description: 'Target: **+2 points** of checkout conversion by the end of the quarter.\n\nThe two bets are saved cards and a search that forgives typos.',
});
op('subtask.add', { card: goal.id, title: 'Baseline the funnel numbers', status: 'done' });
op('subtask.add', { card: goal.id, title: 'Saved cards live for everyone', status: 'in_progress' });
op('subtask.add', { card: goal.id, title: 'Typo-tolerant search live', status: 'todo' });

const routine = op('card.create', { title: 'Weekly dependency audit', status: 'In progress', priority: 'low', project: 'infra', tags: ['routine'] });
op('routine.link', { card: routine.id, routineId: 'dep-audit' });

const search = op('card.create', {
  title: 'Search: forgive typos', status: 'In progress', project: 'shop', ticket: 'SHOP-198', tags: ['search'],
  description: 'Searches like "sneekers" return nothing today.', sessionIds: [sid(4), sid(5)],
});
op('subtask.add', { card: search.id, title: 'Sign off the threshold with product' });

const cards = op('card.create', {
  title: 'Checkout: saved cards', status: 'In progress', priority: 'high', project: 'shop', ticket: 'SHOP-212', tags: ['checkout', 'payments'], due: day(9),
  description: 'Let a returning customer pay with a card they saved before.\n\n- Card numbers stay with the payment provider; we store a token.\n- The picker falls back to the plain form when there are no saved cards.',
  auto: { groupId: 'cg-checkout', ticketKeys: ['SHOP-212'] },
});
op('subtask.add', { card: cards.id, title: 'Agree the API shape with payments', status: 'done' });
op('session.link', { card: cards.id, sessionIds: [sid(1), sid(2), sid(3)] });
op('subtask.add', { card: cards.id, title: 'Announce in the release notes' });
op('note.add', { card: cards.id, text: 'Payments team is fine with the token-only approach. They want the delete endpoint to be idempotent.', by: 'me' });
op('note.add', { card: cards.id, text: 'API is done and in review (PR 481). The UI session is building the picker on it. Still open: whether to drop the legacy column in this release.', by: 'Claude' });

const flaky = op('card.create', { title: 'Flaky checkout e2e tests', status: 'Waiting on me', project: 'shop', tags: ['tests'], sessionIds: [sid(6)] });
const node = op('card.create', { title: 'Upgrade to Node 22', status: 'In review', project: 'infra', tags: ['infra'], sessionIds: [sid(7), sid(8)] });
op('card.create', { title: 'Onboarding emails', status: 'Done', project: 'shop', tags: ['growth'], sessionIds: [sid(12), sid(13)] });

op('link.add', { from: goal.id, to: cards.id, type: 'parent' });
op('link.add', { from: goal.id, to: search.id, type: 'parent' });
op('link.add', { from: sdk.id, to: cards.id, type: 'blocks' });
op('link.add', { from: node.id, to: flaky.id, type: 'relates' });

require('../src/server').main();
console.log(`Taskboard demo on made-up data: http://127.0.0.1:${process.env.TASKBOARD_PORT}/   (Ctrl-C to stop)`);
