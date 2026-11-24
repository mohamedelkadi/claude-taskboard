'use strict';
// What a session worked with that lives somewhere else: pull requests, docs,
// artifacts and Slack conversations, so a card can open them in one click.
//
// A transcript mentions far more links than a session actually used, so only
// four things count: what the user wrote, what Claude told the user, the result
// of a tool that posted or created something, and a Slack conversation a session
// read. Search results, pages read in a browser, command output and subagents do
// not. Only known link shapes on known hosts are kept, rebuilt from their parts,
// so a token in a query string never reaches the board and a look-alike host
// never becomes a link on a card.
//
// Slack's read tools name a channel and a timestamp but no workspace, and a person
// can be in several. The workspace comes from a real permalink to that channel, or
// else from the workspace the connector that did the read clearly belongs to. When
// neither says, the conversation gets no link rather than one that may not open.

// Raise this when what is collected changes: transcripts are then read once more.
const VERSION = 2;
const MAX_KEPT = 40;
const MAX_LINE = 1 << 20;
const MAX_CHANNELS = 200;

const WRITE_TOOL = /(?:^|__)(slack_send_message|slack_send_message_draft|slack_schedule_message|slack_create_canvas|createConfluencePage|updateConfluencePage|create_file|batch|create)$/;
const SLACK_TOOL = /^(mcp__.+?)__slack_(\w+)$/;
const SLACK_HOME = /https:\/\/([a-z0-9-]+)\.slack\.com\/archives\/([A-Z0-9]+)/g;
const FAILED_RESULT = /^\s*\{\s*"(?:ok"\s*:\s*false|error")/;
const TOOL_NAMES = ['slack_', 'ConfluencePage', 'create_file', '__batch', '__create'].map((s) => Buffer.from(s));
const TOOL_RESULT = Buffer.from('"tool_result"');
const HOST_HINTS = ['/pull/', 'slack.com/', 'docs.google.com/', 'drive.google.com/', 'atlassian.net/wiki', 'notion.so/', 'notion.site/', 'figma.com/', 'miro.com/', '/artifact'].map((s) => Buffer.from(s));
const HTTPS = Buffer.from('https://');
const TOOL_USE = Buffer.from('"tool_use"');
const API_REQUEST = Buffer.from('"type":"api-request');

// Blocks the app adds around a prompt; their links are not the user's.
const INJECTED = /<(system-reminder|task-notification|side-sessions-event|ci-monitor-event|local-command-stdout|local-command-stderr)\b[^>]*>[\s\S]*?<\/\1>/g;
const LINK = /\[([^\]\n]{1,120})\]\((https:\/\/[^\s)]+)\)|https:\/\/[^\s<>()[\]{}"'`|\\]+/g;
// Link text that is part of a sentence ("here's the reply", "that thread") names nothing.
const GENERIC_LABEL = /^(?:(?:link|thread|message|doc|docs|page|url|pr)$|(?:here|the|that|this|these|those|it|its|my|your|our|see|open|view|in|on|from|a|an)\b)/i;

const GOOGLE = { document: 'Google Doc', spreadsheets: 'Google Sheet', presentation: 'Google Slides', forms: 'Google Form' };

const titleFrom = (slug) => {
  let t = String(slug || '');
  try {
    t = decodeURIComponent(t);
  } catch (_) {}
  return t.replace(/[+_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
};

/** Slack links carry no name, but they do carry a date, which tells several apart. */
const slackDay = (ts) => new Date(Number(ts) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function slackLink(u, host, parts) {
  const workspace = host.slice(0, -'.slack.com'.length);
  if (!/^[a-z0-9-]+$/.test(workspace) || workspace === 'app') return null;
  if (parts[0] === 'docs' && /^[A-Z0-9]+$/.test(parts[1] || '') && /^[A-Z0-9]+$/.test(parts[2] || '')) {
    return { kind: 'slack', key: `slack:${workspace}/${parts[2]}`, url: `https://${host}/docs/${parts[1]}/${parts[2]}`, label: 'Slack canvas' };
  }
  if (parts[0] !== 'archives' || !/^[A-Z0-9]+$/.test(parts[1] || '')) return null;
  const channel = parts[1];
  if (!parts[2]) return { kind: 'slack', key: `slack:${workspace}/${channel}`, url: `https://${host}/archives/${channel}`, label: 'Slack channel' };
  if (!/^p\d{16}$/.test(parts[2])) return null;
  const ts = `${parts[2].slice(1, 11)}.${parts[2].slice(11)}`;
  const thread = u.searchParams.get('thread_ts');
  if (thread && /^\d{10}\.\d{6}$/.test(thread)) {
    // every reply in a thread is the same conversation
    return { kind: 'slack', key: `slack:${workspace}/${channel}/${thread}`, url: `https://${host}/archives/${channel}/${parts[2]}?thread_ts=${thread}&cid=${channel}`, label: `Thread · ${slackDay(thread)}` };
  }
  return { kind: 'slack', key: `slack:${workspace}/${channel}/${ts}`, url: `https://${host}/archives/${channel}/${parts[2]}`, label: `Message · ${slackDay(ts)}` };
}

function googleLink(host, parts) {
  const safe = (id) => /^[A-Za-z0-9_-]{10,}$/.test(id || '');
  if (host === 'docs.google.com') {
    const at = parts.indexOf('d');
    const type = parts[at - 1];
    if (at < 1 || !GOOGLE[type] || !safe(parts[at + 1])) return null;
    // parts come from URL.pathname, so they are already encoded
    return { kind: 'doc', key: `google:${parts[at + 1]}`, url: `https://docs.google.com/${parts.slice(0, at + 2).join('/')}`, label: GOOGLE[type] };
  }
  if (parts[0] === 'file' && parts[1] === 'd' && safe(parts[2])) {
    return { kind: 'doc', key: `google:${parts[2]}`, url: `https://drive.google.com/file/d/${parts[2]}/view`, label: 'Drive file' };
  }
  const folder = parts.indexOf('folders');
  if (parts[0] === 'drive' && folder > 0 && safe(parts[folder + 1])) {
    return { kind: 'doc', key: `google:${parts[folder + 1]}`, url: `https://drive.google.com/drive/folders/${parts[folder + 1]}`, label: 'Drive folder' };
  }
  return null;
}

/** What a link is, or null when it is not one a card should offer. */
function classify(raw) {
  let u;
  try {
    u = new URL(String(raw).replace(/&amp;/g, '&'));
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'github.com') {
    if (parts[2] !== 'pull' || !/^\d+$/.test(parts[3] || '')) return null;
    if (!/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) return null;
    const repo = `${parts[0]}/${parts[1]}`;
    return { kind: 'pr', key: `pr:${repo.toLowerCase()}#${parts[3]}`, url: `https://github.com/${repo}/pull/${parts[3]}`, label: `${parts[1]}#${parts[3]}` };
  }
  if (host.endsWith('.slack.com')) return slackLink(u, host, parts);
  if (host === 'docs.google.com' || host === 'drive.google.com') return googleLink(host, parts);
  if (host.endsWith('.atlassian.net') && parts[0] === 'wiki') {
    const at = parts.indexOf('pages');
    if (parts[1] !== 'spaces' || at !== 3 || !/^[~\w-]+$/.test(parts[2]) || !/^\d+$/.test(parts[at + 1] || '')) return null;
    return { kind: 'doc', key: `confluence:${host}/${parts[at + 1]}`, url: `https://${host}/wiki/spaces/${parts[2]}/pages/${parts[at + 1]}`, label: titleFrom(parts[at + 2]) || 'Confluence page', named: !!parts[at + 2] };
  }
  if (host === 'notion.so' || host === 'www.notion.so' || host.endsWith('.notion.site')) {
    const last = parts[parts.length - 1] || '';
    const id = (/([0-9a-f]{32})$/i.exec(last) || [])[1];
    if (!id) return null;
    const title = titleFrom(last.slice(0, -32));
    return { kind: 'doc', key: `notion:${id.toLowerCase()}`, url: `https://${host}/${parts.join('/')}`, label: title || 'Notion page', named: !!title };
  }
  if (host === 'figma.com' || host === 'www.figma.com') {
    if (!['design', 'file', 'board', 'proto', 'slides'].includes(parts[0]) || !/^[A-Za-z0-9]+$/.test(parts[1] || '')) return null;
    const node = u.searchParams.get('node-id');
    const nodeOk = node && /^[\d:-]+$/.test(node);
    const name = titleFrom(parts[2]);
    return {
      kind: 'doc',
      key: `figma:${parts[1]}${nodeOk ? `:${node}` : ''}`,
      url: `https://www.figma.com/${parts[0]}/${parts[1]}${parts[2] ? `/${parts[2]}` : ''}${nodeOk ? `?node-id=${node}` : ''}`,
      label: name || 'Figma file',
      named: !!name,
    };
  }
  if (host === 'miro.com' && parts[0] === 'app' && parts[1] === 'board' && /^[\w=-]+$/.test(parts[2] || '')) {
    return { kind: 'doc', key: `miro:${parts[2]}`, url: `https://miro.com/app/board/${parts[2]}`, label: 'Miro board' };
  }
  if (host === 'claude.ai') {
    const m = /^\/((?:code\/|public\/)?artifacts?)\/([\w-]{8,})\/?$/.exec(u.pathname);
    if (m) return { kind: 'artifact', key: `artifact:${m[2]}`, url: `https://claude.ai/${m[1]}/${m[2]}`, label: 'Artifact' };
  }
  return null;
}

function cleanLabel(text) {
  const t = String(text || '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.includes('://') || GENERIC_LABEL.test(t)) return '';
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/** Add one, or freshen the one already there. A real name beats a generic one. */
function keep(list, item, at, cap = MAX_KEPT) {
  const had = list.find((x) => x.key === item.key);
  if (had) {
    if (at > had.at) had.at = at;
    if (item.named && !had.named) {
      had.label = item.label;
      had.named = true;
    }
    return;
  }
  list.push({ key: item.key, kind: item.kind, url: item.url, label: item.label, named: !!item.named, at });
  if (list.length > cap) {
    list.sort((a, b) => b.at - a.at);
    list.length = cap;
  }
}

function collect(text, into, at, allowPr) {
  if (!text || !String(text).includes('https://')) return;
  for (const m of String(text).matchAll(LINK)) {
    const raw = (m[2] || m[0]).replace(/[.,;:!?*_~'’”]+$/, '');
    const found = classify(raw);
    if (!found || (found.kind === 'pr' && !allowPr)) continue;
    // around a PR or Slack link the text is nearly always a sentence ("replied in the thread")
    const label = found.kind === 'pr' || found.kind === 'slack' ? '' : cleanLabel(m[1]);
    keep(into.items, label ? { ...found, label, named: true } : found, at);
  }
}

const textOfResult = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' && b.text) || '').join('\n');
};

const fresh = () => ({ items: [], open: [], reads: [], homes: {}, connectors: {} });

/** Remember a tool call whose result will matter. */
function noteCall(b, into) {
  const name = b.name || '';
  const slack = SLACK_TOOL.exec(name);
  const write = WRITE_TOOL.test(name);
  if (!b.id || (!slack && !write) || into.open.some((c) => c.id === b.id)) return;
  const input = b.input || {};
  let read = null;
  if (slack && slack[2] === 'read_thread') read = { channel: input.channel_id, ts: input.message_ts || input.thread_ts };
  if (slack && slack[2] === 'read_channel') read = { channel: input.channel_id, ts: '' };
  into.open.push({ id: b.id, write, via: slack ? slack[1] : '', read });
  if (into.open.length > 20) into.open.shift();
}

/** A real permalink says which workspace a channel is in, and which one a connector reaches. */
function learnWorkspaces(text, via, into) {
  for (const m of text.replace(/\\\//g, '/').matchAll(SLACK_HOME)) {
    if (m[1] === 'app') continue;
    const known = into.homes[m[2]];
    if (known) {
      if (!known.includes(m[1])) known.push(m[1]);
    } else if (Object.keys(into.homes).length < MAX_CHANNELS) {
      into.homes[m[2]] = [m[1]];
    }
    const counts = (into.connectors[via] = into.connectors[via] || {});
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
}

function noteResult(b, into, at) {
  const call = into.open.find((c) => c.id === b.tool_use_id);
  if (!call) return;
  into.open = into.open.filter((c) => c !== call);
  if (b.is_error) return;
  const text = textOfResult(b.content);
  if (FAILED_RESULT.test(text.slice(0, 200))) return;
  if (call.write) collect(text, into, at, false);
  if (!call.via) return;
  learnWorkspaces(text, call.via, into);
  const r = call.read;
  // U… is a person rather than a conversation, and has no link of its own
  if (!r || !/^[CGD][A-Z0-9]+$/.test(String(r.channel || '')) || (r.ts && !/^\d{10}\.\d{6}$/.test(String(r.ts)))) return;
  const had = into.reads.find((x) => x.channel === r.channel && x.ts === (r.ts || ''));
  if (had) {
    if (at > had.at) had.at = at;
    return;
  }
  into.reads.push({ channel: r.channel, ts: r.ts || '', via: call.via, at });
  if (into.reads.length > MAX_KEPT) {
    into.reads.sort((x, y) => y.at - x.at);
    into.reads.length = MAX_KEPT;
  }
}

/** Take what counts from one transcript line. Most lines are ruled out without decoding them. */
function readLine(buf, into) {
  if (buf.length < 30 || buf.length > MAX_LINE) return;
  if (buf.subarray(0, 48).includes(API_REQUEST)) return;
  const toolCall = buf.includes(TOOL_USE) && TOOL_NAMES.some((n) => buf.includes(n));
  // the result of a Slack read has no link in it, so it is known by its call's id
  const awaited = into.open.length > 0 && buf.includes(TOOL_RESULT) && into.open.some((c) => buf.includes(c.id));
  if (!toolCall && !awaited && !(buf.includes(HTTPS) && HOST_HINTS.some((n) => buf.includes(n)))) return;
  let o;
  try {
    o = JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return;
  }
  if (!o || o.isSidechain || o.isMeta || o.isCompactSummary) return;
  const at = (o.timestamp && Date.parse(o.timestamp)) || 0;
  const content = o.message && o.message.content;
  if (o.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text') collect(b.text, into, at, false);
      if (b && b.type === 'tool_use') noteCall(b, into);
    }
  } else if (o.type === 'user') {
    if (typeof content === 'string') collect(content.replace(INJECTED, ''), into, at, true);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'text') collect(String(b.text || '').replace(INJECTED, ''), into, at, true);
        if (b && b.type === 'tool_result') noteResult(b, into, at);
      }
    }
  }
}

const byNewest = (a, b) => b.at - a.at || a.key.localeCompare(b.key);

/**
 * Everything from several lists, one entry per resource, newest first. The limit is
 * per transcript: a card with many sessions keeps every link, and folds them on screen.
 */
function merge(lists) {
  const out = [];
  for (const list of lists) for (const r of list || []) keep(out, r, r.at, Infinity);
  return out.sort(byNewest);
}

const trackedPr = (pr) => `pr:${String(pr.repo || '').toLowerCase()}#${pr.number}`;

/** Which workspace a channel is in, from everything the board has read. */
function slackDirectory(details) {
  const homes = new Map();
  const tallies = new Map();
  const home = (channel, workspace) => {
    if (!homes.has(channel)) homes.set(channel, new Set());
    homes.get(channel).add(workspace);
  };
  for (const d of details) {
    const links = d && d.links;
    if (!links) continue;
    for (const r of links.items || []) {
      const m = r.kind === 'slack' && /^slack:([a-z0-9-]+)\/([A-Z0-9]+)/.exec(r.key);
      if (m) home(m[2], m[1]);
    }
    for (const [channel, list] of Object.entries(links.homes || {})) for (const w of list) home(channel, w);
    for (const [via, counts] of Object.entries(links.connectors || {})) {
      if (!tallies.has(via)) tallies.set(via, new Map());
      const tally = tallies.get(via);
      for (const [w, n] of Object.entries(counts)) tally.set(w, (tally.get(w) || 0) + n);
    }
  }
  // Messages quote links from other workspaces, so a connector's own is the one that clearly dominates.
  const usual = new Map();
  for (const [via, tally] of tallies) {
    const total = [...tally.values()].reduce((a, b) => a + b, 0);
    const [top, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n / total >= 0.8) usual.set(via, top);
  }
  return {
    workspaceFor(channel, via) {
      const known = homes.get(channel);
      const own = usual.get(via) || '';
      if (known && known.size === 1) return [...known][0];
      if (known) return known.has(own) ? own : '';
      return own;
    },
  };
}

/** Links for the Slack conversations a session read, where the workspace is known. */
function slackReads(details, directory, have) {
  const reads = details.flatMap((d) => (d && d.links && d.links.reads) || []);
  const out = [];
  const keys = new Set(have.map((r) => r.key));
  // threads first, so a channel is only offered when nothing more exact is
  for (const r of reads.slice().sort((a, b) => Number(!a.ts) - Number(!b.ts))) {
    const workspace = directory.workspaceFor(r.channel, r.via);
    if (!workspace) continue;
    const base = `https://${workspace}.slack.com/archives/${r.channel}`;
    const found = classify(r.ts ? `${base}/p${r.ts.replace('.', '')}` : base);
    if (!found) continue;
    if (!r.ts && [...keys].some((k) => k.startsWith(`${found.key}/`))) continue;
    const label = r.ts ? `Thread · ${slackDay(r.ts)}` : r.channel.startsWith('D') ? 'Direct message' : found.label;
    out.push({ ...found, label, named: false, at: r.at });
    keys.add(found.key);
  }
  return out;
}

/**
 * A session's resources: those in its transcripts (a resumed session has several),
 * the Slack conversations it read, and the pages Claude recorded it publishing.
 * PRs the app already tracks are left out, since they are shown with their state.
 */
function forSession(session, details, directory = slackDirectory(details)) {
  const artifacts = [];
  for (const a of session.artifacts || []) {
    const known = classify(a.url);
    const base = known && known.kind === 'artifact' ? known : /^https:\/\//.test(a.url || '') ? { kind: 'artifact', key: `artifact:${a.url}`, url: a.url, label: 'Artifact' } : null;
    if (!base) continue;
    artifacts.push({ ...base, label: a.title || base.label, named: !!a.title, at: session.lastActivityAt || 0 });
  }
  const tracked = new Set((session.prs || []).map(trackedPr));
  // a link someone actually shared wins over one built for the same conversation
  const shared = merge([artifacts, ...details.map((d) => d && d.links && d.links.items)]);
  return merge([shared, slackReads(details, directory, shared)]).filter((r) => !tracked.has(r.key));
}

module.exports = { VERSION, fresh, readLine, classify, merge, forSession, slackDirectory, trackedPr };
