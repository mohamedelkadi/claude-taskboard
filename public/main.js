'use strict';
// Start-up and the page-wide event listeners that route to ACTIONS, CHANGES,
// COMMITS and INPUTS.

document.addEventListener('click', (e) => {
  if (e.target.id === 'modal') return closeModal(null); // the backdrop
  const el = e.target.closest('[data-act]');
  if (!el) return;
  // a link or control inside a clickable region keeps its own behaviour
  const inner = e.target.closest('[data-stop]');
  if (inner && inner !== el && el.contains(inner)) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  fn(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el, e);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'q') {
    S.q = t.value;
    return renderMain();
  }
  if (t.dataset.input && INPUTS[t.dataset.input]) INPUTS[t.dataset.input](t);
  if (t.classList.contains('d-title')) {
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 'px';
  }
});

// Text fields save when focus leaves them.
document.addEventListener('focusout', (e) => {
  if (S.swapping) return;
  const el = e.target;
  if (el.dataset && el.dataset.commit && COMMITS[el.dataset.commit]) COMMITS[el.dataset.commit](el);
});

document.addEventListener('pointerdown', () => (S.pointerDown = true), true);
const pointerReleased = () =>
  setTimeout(() => {
    S.pointerDown = false;
    if (S.renderPending) {
      S.renderPending = false;
      render();
    }
  }, 0);
document.addEventListener('pointerup', pointerReleased, true);
document.addEventListener('pointercancel', pointerReleased, true);

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t.matches && t.matches('input, textarea, select');

  if (e.key === 'Escape') {
    if (M.kind) return closeModal(null);
    if (t.classList.contains('desc-edit')) {
      S.editDesc = false;
      return renderDrawer();
    }
    if (t.classList.contains('sub-title-edit')) {
      S.editSub = null;
      return renderDrawer();
    }
    if (t.id === 'composer') {
      S.composer = null;
      return render();
    }
    if (typing) return t.blur();
    if (S.cardId) return closeCard();
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    if (t.id === 'composer') {
      e.preventDefault();
      return composerAdd();
    }
    if (t.dataset.enter && ACTIONS[t.dataset.enter]) {
      e.preventDefault();
      return ACTIONS[t.dataset.enter](t, e);
    }
    if (t.classList.contains('d-title')) {
      e.preventDefault();
      return t.blur();
    }
    if (t.tagName === 'INPUT' && t.dataset.commit) return t.blur();
    if (t.tagName === 'TEXTAREA' && (e.metaKey || e.ctrlKey)) {
      if (t.dataset.commit) return t.blur();
      if (t.id === 'new-note') return ACTIONS['note-add']();
    }
    return;
  }

  if (typing || e.metaKey || e.ctrlKey || e.altKey || M.kind) return;
  if (e.key === '/') {
    e.preventDefault();
    $('#q').focus();
  } else if (e.key === 'n') {
    e.preventDefault();
    ACTIONS['new-card']({ dataset: {} });
  } else if ('1234'.includes(e.key)) {
    S.view = ['board', 'needs', 'sessions', 'graph'][+e.key - 1];
    setHash();
    render();
  }
});

window.addEventListener('hashchange', () => {
  readHash();
  render();
});

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    S.connected = true;
    let v = 0;
    try {
      v = JSON.parse(e.data).version;
    } catch (_) {}
    if (!S.data || v !== S.data.version) loadState().catch(() => {});
    else renderTop();
  };
  es.onerror = () => {
    S.connected = false; // the browser retries on its own
    if (S.data) renderTop();
  };
}

(async function init() {
  initBoardDnD();
  initGraph();
  try {
    await loadState();
  } catch (_) {
    $('#main').innerHTML = '<div class="loading">The board server is not answering. Run <code>taskboard start</code> and reload.</div>';
    return;
  }
  readHash();
  render();
  connect();
  // keep "5m ago" honest
  setInterval(() => {
    if (!S.drag && !S.pointerDown && !M.kind && S.view !== 'graph') render();
  }, 60000);
})();
