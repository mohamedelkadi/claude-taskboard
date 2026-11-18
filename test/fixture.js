'use strict';
// Builds a small fake of Claude's folders in a temp directory and points the
// board at it. Must be required before anything under ../src.
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-test-'));
const claudeDir = path.join(root, 'claude');
const desktopDir = path.join(root, 'desktop');
process.env.TASKBOARD_CLAUDE_DIR = claudeDir;
process.env.TASKBOARD_DESKTOP_DIR = desktopDir;
process.env.TASKBOARD_DATA_DIR = path.join(root, 'data');
process.env.TASKBOARD_PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.TASKBOARD_NO_OPEN = '1'; // never launch Claude or Finder from a test

const sessDir = path.join(desktopDir, 'claude-code-sessions', 'acct', 'org');
const projDir = path.join(claudeDir, 'projects', '-work-app');
fs.mkdirSync(sessDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = { root: `local_${uuid(1)}`, child: `local_${uuid(2)}`, other: `local_${uuid(3)}`, run1: `local_${uuid(4)}`, run2: `local_${uuid(5)}`, old: `local_${uuid(6)}` };
const T0 = Date.now() - 3600e3;

function desktopSession(id, n, extra) {
  const d = {
    sessionId: id, cliSessionId: uuid(100 + n), cwd: '/work/app', originCwd: '/work/app', title: `Session ${n}`,
    createdAt: T0 + n * 1000, lastActivityAt: T0 + n * 60000, isArchived: false, model: 'claude-test', completedTurns: 2, ...extra,
  };
  fs.writeFileSync(path.join(sessDir, `${id}.json`), JSON.stringify(d));
  return d;
}

desktopSession(ids.root, 1, {
  title: 'PROJ-100 search root', postTurnSummary: { status_category: 'blocked', status_detail: 'waiting', needs_action: 'answer the question', summarizes_uuid: 'u-1' },
  prs: [{ prNumber: 7, repo: 'acme/app', url: 'https://github.com/acme/app/pull/7', state: 'OPEN', branch: 'proj-100/fix' }],
});
desktopSession(ids.child, 2, { title: 'Child of root', spawnedFrom: { sessionId: ids.root, name: 'child' }, postTurnSummary: { status_category: 'completed', status_detail: 'all good', needs_action: '' } });
desktopSession(ids.other, 3, { title: 'Unrelated work', branch: 'claude/review-26397-eaa106', prs: [{ prNumber: 7, repo: 'acme/app', url: 'https://github.com/acme/app/pull/7', state: 'OPEN' }] });
desktopSession(ids.run1, 4, { title: 'Daily report', scheduledTaskId: 'daily', postTurnSummary: { status_category: 'completed', status_detail: 'ran', needs_action: '' } });
desktopSession(ids.run2, 5, { title: 'Daily report', scheduledTaskId: 'daily', postTurnSummary: { status_category: 'blocked', status_detail: 'login expired', needs_action: 'log in again', summarizes_uuid: 'u-5' } });
desktopSession(ids.old, 6, { title: 'Archived thing', isArchived: true, postTurnSummary: { status_category: 'review_ready', status_detail: 'x', needs_action: '' } });

fs.writeFileSync(
  path.join(desktopDir, 'claude_desktop_config.json'),
  JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': { 'acct/org': { groups: [{ id: 'cg-1', name: 'Search' }], assignments: { [`code:${ids.root}`]: 'cg-1' } } } } } })
);

// transcript of the root session: a step list that advances, logged twice, then a wrap-up
const tool = (id, name, input) => JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: new Date(T0).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const lines = [
  JSON.stringify({ type: 'api-request', params: { tools: [{ name: 'mcp__ccd_turn__update_plan', type: 'tool_use' }] } }),
  JSON.stringify({ type: 'user', isSidechain: false, cwd: '/work/app', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ignore</system-reminder>\nfix the search ranking' }] } }),
  tool('t1', 'mcp__ccd_turn__update_plan', { items: [{ content: 'Read code', status: 'in_progress' }, { content: 'Fix it', status: 'pending' }, { content: 'Test', status: 'pending' }], scope: 'first_task' }),
  tool('t2', 'mcp__ccd_turn__update_plan', { advance: true }),
  tool('t2', 'mcp__ccd_turn__update_plan', { advance: true }), // the same call, logged again
  JSON.stringify({ type: 'cost-state', totalCostUSD: 1.239 }),
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'and add a test' }),
];
const transcript = path.join(projDir, `${uuid(101)}.jsonl`);
fs.writeFileSync(transcript, lines.join('\n') + '\n');

module.exports = {
  root, ids, uuid, transcript, tool, desktopSession, sessDir,
  cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
};
