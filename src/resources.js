'use strict';
// What a session worked with that lives somewhere else: pull requests, docs,
// artifacts and Slack conversations, so a card can open them in one click.
//
// A transcript mentions far more links than a session actually used, so only
// three places count: what the user wrote, what Claude told the user, and the
// result of a tool that posted or created something. Search results, pages read
// in a browser, command output and subagents do not. Only known link shapes on
// known hosts are kept, rebuilt from their parts, so a token in a query string
// never reaches the board and a look-alike host never becomes a link on a card.

// Raise this when what is collected changes: transcripts are then read once more.
const VERSION = 1;
const MAX_KEPT = 40;
const MAX_LINE = 1 << 20;

const WRITE_TOOL = /(?:^|__)(slack_send_message|slack_send_message_draft|slack_schedule_message|slack_create_canvas|createConfluencePage|updateConfluencePage|create_file|batch|create)$/;
const TOOL_NAMES = ['slack_send_message', 'slack_schedule_message', 'slack_create_canvas', 'ConfluencePage', 'create_file', '__batch', '__create'].map((s) => Buffer.from(s));
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
function keep(list, item, at) {
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
  if (list.length > MAX_KEPT) {
    list.sort((a, b) => b.at - a.at);
    list.length = MAX_KEPT;
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

const fresh = () => ({ items: [], open: [] });

/** Take what counts from one transcript line. Most lines are ruled out without decoding them. */
function readLine(buf, into) {
  if (buf.length < 30 || buf.length > MAX_LINE) return;
  if (buf.subarray(0, 48).includes(API_REQUEST)) return;
  const toolCall = buf.includes(TOOL_USE) && TOOL_NAMES.some((n) => buf.includes(n));
  if (!toolCall && !(buf.includes(HTTPS) && HOST_HINTS.some((n) => buf.includes(n)))) return;
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
      if (b && b.type === 'tool_use' && b.id && WRITE_TOOL.test(b.name || '') && !into.open.includes(b.id)) {
        into.open.push(b.id);
        if (into.open.length > 20) into.open.shift();
      }
    }
  } else if (o.type === 'user') {
    if (typeof content === 'string') collect(content.replace(INJECTED, ''), into, at, true);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'text') collect(String(b.text || '').replace(INJECTED, ''), into, at, true);
        if (b && b.type === 'tool_result' && into.open.includes(b.tool_use_id)) {
          into.open = into.open.filter((id) => id !== b.tool_use_id);
          if (!b.is_error) collect(textOfResult(b.content), into, at, false);
        }
      }
    }
  }
}

const byNewest = (a, b) => b.at - a.at || a.key.localeCompare(b.key);

/** Everything from several lists, one entry per resource, newest first. */
function merge(lists) {
  const out = [];
  for (const list of lists) for (const r of list || []) keep(out, r, r.at);
  return out.sort(byNewest);
}

const trackedPr = (pr) => `pr:${String(pr.repo || '').toLowerCase()}#${pr.number}`;

/**
 * A session's resources: those in its transcripts (a resumed session has several)
 * and the pages Claude recorded it publishing. PRs the app already tracks are left
 * out, since they are shown with their state.
 */
function forSession(session, details) {
  const artifacts = [];
  for (const a of session.artifacts || []) {
    const known = classify(a.url);
    const base = known && known.kind === 'artifact' ? known : /^https:\/\//.test(a.url || '') ? { kind: 'artifact', key: `artifact:${a.url}`, url: a.url, label: 'Artifact' } : null;
    if (!base) continue;
    artifacts.push({ ...base, label: a.title || base.label, named: !!a.title, at: session.lastActivityAt || 0 });
  }
  const tracked = new Set((session.prs || []).map(trackedPr));
  return merge([artifacts, ...details.map((d) => d && d.links && d.links.items)]).filter((r) => !tracked.has(r.key));
}

module.exports = { VERSION, fresh, readLine, classify, merge, forSession, trackedPr };
