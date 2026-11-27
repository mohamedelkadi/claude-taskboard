'use strict';
// The panel under the search box: sessions whose conversation mentions what you typed,
// for the one you remember but cannot name. The Diary has its own search, so it stays out there.

const CV = { q: '', data: null, req: 0, timer: null, retry: null, open: false, at: -1 };
const CV_WHO = { prompt: 'You', answer: 'Claude', tool: 'Command' };

/** A passage from the server, escaped, with the matched words marked. */
const convoMarked = (text) => esc(text).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');

function convoClose() {
  CV.open = false;
  CV.at = -1;
  clearTimeout(CV.retry);
  const el = $('#convo');
  if (el) el.hidden = true;
}

function convoPlace() {
  const input = $('#q');
  const el = $('#convo');
  if (!input || !el) return;
  const box = input.getBoundingClientRect();
  const width = Math.min(580, window.innerWidth - 24);
  el.style.width = `${width}px`;
  el.style.top = `${box.bottom + 6}px`;
  el.style.left = `${Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12))}px`;
  el.style.maxHeight = `${Math.max(180, Math.min(600, window.innerHeight - box.bottom - 18))}px`;
}

function convoRow(r, i) {
  const s = r.exists ? ix().sessions.get(r.id) : null;
  const hits = r.hits
    .map((h) => `<div class="convo-hit"><span class="convo-who">${esc(CV_WHO[h.kind] || h.kind)}</span><span class="convo-text" dir="auto">${convoMarked(h.text)}</span></div>`)
    .join('');
  const card = r.card
    ? `<a class="chip" href="#card=${esc(r.card.key)}" data-act="open-card" data-card="${esc(r.card.id)}" data-stop>${esc(r.card.key)} ${esc(r.card.title.slice(0, 30))}</a>`
    : '';
  return `<div class="convo-row${i === CV.at ? ' on' : ''}" data-index="${i}"${s ? ` data-act="session-info" data-session="${esc(s.id)}"` : ''}>
    <div class="convo-head">
      ${s ? stateDot(s.estate) : ''}
      <span class="convo-title" dir="auto">${esc(r.title)}</span>
      ${s ? openButton(s) : '<span class="muted">No longer in Claude</span>'}
    </div>
    <div class="convo-meta">${projChip(r.projectName)}${card}${r.archived ? '<span>archived</span>' : ''}<span title="${esc(fullDate(r.lastActivityAt))}">${esc(ago(r.lastActivityAt))}</span></div>
    ${hits}
  </div>`;
}

function convoRender() {
  const el = $('#convo');
  const d = CV.data;
  if (!el || !d) return;
  const st = d.status || {};
  const list = d.results || [];
  const notes = [];
  if (d.corrected && d.corrected.length) notes.push(`Also searched for ${d.corrected.map((c) => `<strong>${esc(c.to)}</strong>`).join(', ')}`);
  if (st.left > 0) notes.push(`Still reading your conversations, ${st.left} of ${st.total} to go, so more may appear.`);
  let body = '';
  if (!st.available) body = `<div class="convo-empty">Searching inside conversations needs Node 22.13 or newer. This board runs on Node ${esc(st.node || '')}.</div>`;
  else if (list.length) body = list.map(convoRow).join('');
  else if (!st.ready) body = '<div class="convo-empty">Reading your conversations for the first time. This takes a few seconds.</div>';
  else body = `<div class="convo-empty">No conversation mentions “${esc(d.q)}”.</div>`;
  el.innerHTML = `
    <div class="convo-top"><strong>In conversations</strong><span class="muted">${list.length ? `${d.total} session${d.total === 1 ? '' : 's'}, best first` : ''}</span></div>
    ${notes.map((n) => `<div class="convo-note">${n}</div>`).join('')}
    ${body}`;
  CV.open = true;
  el.hidden = false;
  convoPlace();
}

async function convoFetch() {
  const q = S.q.trim();
  const req = ++CV.req;
  clearTimeout(CV.retry);
  let answer = null;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    answer = await res.json();
  } catch (_) {
    return; // the board server is away; the header already says so
  }
  if (req !== CV.req || S.q.trim() !== q || S.view === 'diary' || !answer.ok) return;
  if (document.activeElement !== $('#q') && !CV.open) return; // moved on while it was on its way
  if (CV.q !== q) CV.at = -1;
  CV.q = q;
  CV.data = answer;
  convoRender();
  if (answer.status && answer.status.available && (answer.status.left > 0 || !answer.status.ready)) {
    CV.retry = setTimeout(() => CV.open && convoFetch(), 1500);
  }
}

/** The search box changed. */
function convoInput() {
  clearTimeout(CV.timer);
  clearTimeout(CV.retry);
  CV.req++;
  if (S.q.trim().length < 2 || S.view === 'diary') return convoClose();
  CV.timer = setTimeout(convoFetch, 180);
}

function convoMove(step) {
  const rows = $$('.convo-row', $('#convo'));
  if (!rows.length) return;
  CV.at = CV.at < 0 ? (step > 0 ? 0 : rows.length - 1) : (CV.at + step + rows.length) % rows.length;
  rows.forEach((row, i) => row.classList.toggle('on', i === CV.at));
  rows[CV.at].scrollIntoView({ block: 'nearest' });
}

// Before the page-wide handlers, so Esc closes this panel first and Enter opens the row.
document.addEventListener('keydown', (e) => {
  if (e.target.id !== 'q' || !CV.open || e.isComposing) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    convoClose();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    convoMove(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter' && CV.at >= 0) {
    e.preventDefault();
    e.stopPropagation();
    const row = $$('.convo-row', $('#convo'))[CV.at];
    if (row && row.dataset.session) {
      convoClose();
      e.target.blur(); // Esc in a focused search field would also clear what was typed
      sessionModal(row.dataset.session);
    }
  }
}, true);

document.addEventListener('click', (e) => {
  if (!CV.open) return;
  const inside = e.target.closest('#convo');
  if (inside ? e.target.closest('[data-act]') : e.target.id !== 'q') convoClose();
}, true);

document.addEventListener('focusin', (e) => {
  if (e.target.id !== 'q' || CV.open || S.view === 'diary' || S.q.trim().length < 2) return;
  if (CV.data && CV.q === S.q.trim()) convoRender();
  else convoInput();
});

window.addEventListener('resize', () => CV.open && convoPlace());
