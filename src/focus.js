'use strict';
// Focus mode: what needs a decision right now. Claude's registry says a session is waiting;
// the end of its transcript says on what, because the call it is stopped on has no result yet.
// Read-only. What comes out of a transcript is shown to the user and never acted on.
const fs = require('fs');

const TAIL_BYTES = 768 * 1024; // a transcript can be hundreds of MB; the open call is at its end
const PREVIEW_CHARS = 2400;
const PLAN_CHARS = 12000;
const HOUR = 3600000;
const REPLY_WINDOW = 24 * HOUR; // a finished turn's question older than this stays on Needs me
const ACTIVE_WINDOW = 2 * HOUR;
const MAX_ACTIVE = 12;
// these hold other work open while it runs: being unanswered says nothing about a prompt
const CONTAINERS = new Set(['Agent', 'Task', 'Workflow']);

const clip = (v, max) => {
  const t = String(v == null ? '' : v).trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const oneLine = (v, max) => clip(String(v == null ? '' : v).replace(/\s+/g, ' '), max);
const toolName = (name) => String(name || 'a tool').replace(/^mcp__.*?__/, '');

/** The complete lines at the end of a file. */
function tailLines(file) {
  const size = fs.statSync(file).size;
  const length = Math.min(size, TAIL_BYTES);
  const buf = Buffer.allocUnsafe(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  if (length < size) lines.shift(); // the read began part-way through this one
  return lines;
}

/** The tool calls of the last assistant message that have no result yet. */
function unanswered(lines) {
  const open = new Map();
  let message = null;
  for (const line of lines) {
    if (!line.includes('"assistant"') && !line.includes('"tool_result"')) continue;
    if (line.slice(0, 48).includes('"type":"api-request')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const content = o && !o.isSidechain && o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    if (o.type === 'assistant') {
      // one message's parallel calls are logged as separate lines under the same id
      const id = o.message.id || null;
      if (id !== message) {
        open.clear();
        message = id;
      }
      for (const b of content) if (b && b.type === 'tool_use' && b.id) open.set(b.id, b);
    } else if (o.type === 'user') {
      for (const b of content) if (b && b.type === 'tool_result') open.delete(b.tool_use_id);
    }
  }
  return [...open.values()];
}

function previewCall(call) {
  const i = call.input && typeof call.input === 'object' ? call.input : {};
  const base = { id: call.id, tool: toolName(call.name) };
  if (call.name === 'Bash') return { ...base, label: 'Run a command', note: oneLine(i.description, 160), text: clip(i.command, PREVIEW_CHARS) };
  if (call.name === 'Edit') {
    const mark = (text, sign) => String(text || '').split('\n').map((l) => `${sign} ${l}`).join('\n');
    return { ...base, label: `Edit ${clip(i.file_path, 200)}`, note: '', text: clip(`${mark(i.old_string, '-')}\n${mark(i.new_string, '+')}`, PREVIEW_CHARS) };
  }
  if (call.name === 'Write') return { ...base, label: `Write ${clip(i.file_path, 200)}`, note: '', text: clip(i.content, PREVIEW_CHARS) };
  return { ...base, label: `Use ${base.tool}`, note: '', text: clip(JSON.stringify(i, null, 2), PREVIEW_CHARS) };
}

function slimQuestions(list) {
  return (Array.isArray(list) ? list : [])
    .filter((q) => q && q.question)
    .slice(0, 4)
    .map((q) => ({
      header: oneLine(q.header, 40),
      question: clip(q.question, 600),
      multi: !!q.multiSelect,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o) => o && o.label)
        .slice(0, 6)
        .map((o) => ({ label: oneLine(o.label, 120), description: clip(o.description, 300) })),
    }));
}

/** What a waiting session is asking, from the calls it has open. */
function promptFrom(calls, live) {
  const since = Number(live.statusAt) || 0;
  const reason = oneLine(live.waitingFor, 80);
  const ask = calls.find((c) => c.name === 'AskUserQuestion');
  const questions = ask ? slimQuestions(ask.input && ask.input.questions) : [];
  if (questions.length) {
    return { kind: 'question', token: `live:${ask.id}`, since, reason, ask: oneLine(questions[0].question, 400), questions };
  }
  const plan = calls.find((c) => c.name === 'ExitPlanMode');
  if (plan) {
    const input = plan.input || {};
    return { kind: 'plan', token: `live:${plan.id}`, since, reason, ask: 'Approve or revise the plan.', plan: clip(input.plan, PLAN_CHARS), planFile: clip(input.planFilePath, 300) };
  }
  const tools = calls.filter((c) => !CONTAINERS.has(c.name)).slice(-3).map(previewCall);
  if (tools.length) {
    const first = tools[0];
    const ask = tools.length > 1 ? `Waiting on one of ${tools.length} tool calls.` : oneLine(`${first.label}${first.tool === 'Bash' ? `: ${first.text}` : ''}`, 400);
    return { kind: 'permission', token: `live:${tools.map((t) => t.id).join('+')}`, since, reason, ask, calls: tools };
  }
  return { kind: 'input', token: `live:${since}`, since, reason, ask: 'Waiting for your input.' };
}

const seen = new Map(); // transcript -> { size, mtimeMs, calls }: a waiting session writes nothing

function openCalls(file) {
  if (!file) return [];
  try {
    const st = fs.statSync(file);
    const hit = seen.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.calls;
    const calls = unanswered(tailLines(file));
    if (seen.size > 40) seen.clear();
    seen.set(file, { size: st.size, mtimeMs: st.mtimeMs, calls });
    return calls;
  } catch (_) {
    return [];
  }
}

/** The prompt a session in Claude's `waiting` status is stopped on. */
function readWaiting(file, live) {
  return promptFrom(openCalls(file), live);
}

/**
 * Which sessions Focus mode shows, as ids, in the order they should come up.
 * decide: stopped on a live prompt, oldest first. reply: a finished turn asked something and
 * is still current, oldest first. active: running or just finished, for the quiet strip.
 */
function build(sessions, routines, now = Date.now()) {
  const latest = new Set([...routines.values()].map((r) => r.latest.id));
  const open = sessions.filter((s) => !s.archived && (!s.routineId || latest.has(s.id)));
  const needs = open.filter((s) => s.estate === 'needs_you');
  const oldest = (at) => (a, b) => at(a) - at(b);
  const decide = needs.filter((s) => s.waiting).sort(oldest((s) => s.waiting.since || s.lastActivityAt));
  const reply = needs.filter((s) => !s.waiting && (s.live || now - s.lastActivityAt < REPLY_WINDOW)).sort(oldest((s) => s.lastActivityAt));
  const active = open
    .filter((s) => !s.hidden && (s.estate === 'running' || (s.estate !== 'needs_you' && now - s.lastActivityAt < ACTIVE_WINDOW)))
    .sort((a, b) => (b.estate === 'running') - (a.estate === 'running') || b.lastActivityAt - a.lastActivityAt)
    .slice(0, MAX_ACTIVE);
  const ids = (list) => list.map((s) => s.id);
  return { decide: ids(decide), reply: ids(reply), active: ids(active) };
}

module.exports = { build, readWaiting, unanswered, promptFrom, tailLines };
