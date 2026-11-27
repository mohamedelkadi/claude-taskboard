'use strict';
// One-click links to what a card's sessions worked with: pull requests, docs,
// artifacts and Slack conversations. Nothing is shown when a card has none.

const RES_KINDS = [
  ['pr', 'Pull requests', '⑂'],
  ['artifact', 'Artifacts', '◆'],
  ['doc', 'Docs', '▤'],
  ['slack', 'Slack', '#'],
];
const RES_MARK = Object.fromEntries(RES_KINDS.map(([kind, , mark]) => [kind, mark]));
const RES_NAME = { pr: 'Pull request', artifact: 'Artifact', doc: 'Doc', slack: 'Slack' };

function resourceChip(r) {
  if (!/^https:\/\//.test(r.url || '')) return '';
  const where = r.label === RES_NAME[r.kind] ? r.label : `${RES_NAME[r.kind] || 'Link'}: ${r.label}`;
  return `<a class="chip res res-${esc(r.kind)}" href="${esc(r.url)}" target="_blank" rel="noopener" title="Open ${esc(where)}" data-stop><span class="res-mark" aria-hidden="true">${esc(RES_MARK[r.kind] || '↗')}</span><span class="res-label">${esc(r.label)}</span></a>`;
}

/** On the card itself: the newest few. The rest are one click away, in the card. */
function cardResources(v) {
  const list = v.resources || [];
  if (!list.length) return '';
  const shown = list.slice(0, 3);
  const more = list.length - shown.length;
  return `<div class="card-res">${shown.map(resourceChip).join('')}${more > 0 ? `<span class="muted" title="Open the card to see all ${list.length}">+${more}</span>` : ''}</div>`;
}

const RES_FOLD = 6;
const resOpen = new Set(); // the lists showing everything, until the page reloads

/** A list of chips, newest first, folded when it is long enough to bury the card. */
function foldedChips(id, chips) {
  const all = chips.filter(Boolean);
  const open = resOpen.has(id) || all.length <= RES_FOLD;
  const shown = open ? all : all.slice(0, RES_FOLD);
  const toggle = all.length > RES_FOLD
    ? `<button class="fold res-more" data-act="res-more" data-res="${esc(id)}" aria-expanded="${open}">${open ? 'Show fewer' : `Show all ${all.length}`}</button>`
    : '';
  return `<div class="res-chips">${shown.join('')}${toggle}</div>`;
}

ACTIONS['res-more'] = (el) => {
  const id = el.dataset.res;
  if (resOpen.has(id)) resOpen.delete(id);
  else resOpen.add(id);
  renderDrawer();
  if (id.startsWith('session:')) refreshSessionModal(id.slice('session:'.length));
};

/** The card panel's section, grouped by kind. PRs keep their open/merged colours. */
function relatedSection(card) {
  const v = card.view;
  const list = v.resources || [];
  if (!v.prs.length && !list.length) return '';
  const rows = RES_KINDS.map(([kind, name]) => {
    const chips = (kind === 'pr' ? v.prs.map(prChip) : []).concat(list.filter((r) => r.kind === kind).map(resourceChip)).filter(Boolean);
    return chips.length ? `<div class="res-row"><span class="res-kind">${esc(name)}</span>${foldedChips(`card:${card.id}:${kind}`, chips)}</div>` : '';
  }).join('');
  return `<div class="sec related"><div class="sec-head"><h4>Related</h4></div>${rows}</div>`;
}

/** In one session's details: what that session itself used. */
function sessionResources(s) {
  const list = s.resources || [];
  return list.length ? `<div><h5>Related</h5>${foldedChips(`session:${s.id}`, list.map(resourceChip))}</div>` : '';
}
