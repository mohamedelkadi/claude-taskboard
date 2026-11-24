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
    convoInput();
    return renderMain();
  }
  if (t.id === 'new-note') noteDrafts.set(S.cardId, t.value);
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
const pointerReleased = () => setTimeout(releasePointer, 0);
document.addEventListener('pointerup', pointerReleased, true);
document.addEventListener('pointercancel', pointerReleased, true);
// A pointer marked down holds every repaint back, so a release that never gets reported
// must not outlast the next move: a pointer that moves with no button held is not down.
document.addEventListener('pointermove', (e) => S.pointerDown && e.buttons === 0 && releasePointer(), true);
window.addEventListener('blur', releasePointer);

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t.matches && t.matches('input, textarea, select');

  if (e.key === 'Escape') {
    if (closeLightbox()) return;
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
  } else if (S.view === 'diary' && !S.cardId && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    diaryStep(e.key === 'ArrowLeft' ? -1 : 1);
  } else if ('12345'.includes(e.key)) {
    S.view = ['board', 'needs', 'sessions', 'graph', 'diary'][+e.key - 1];
    setHash();
    render();
  }
});

// Files come onto the open card by paste or drop. In the note box or the description they
// are also linked where the cursor is.
const fileField = (el) => {
  if (!el || !el.closest) return null;
  if (el.closest('.desc-edit')) return 'desc';
  return el.closest('.note-compose') ? 'new-note' : null;
};

document.addEventListener('paste', (e) => {
  if (!S.cardId || M.kind || !e.clipboardData) return;
  const files = [...e.clipboardData.files];
  if (!files.length) return;
  const keep = fileField(e.target);
  if (!keep && e.target.matches && e.target.matches('input, textarea, select')) return;
  // Word, Excel and web pages put text on the clipboard with a picture of it: that paste is the text
  if (keep && e.clipboardData.getData('text/plain') && e.clipboardData.getData('text/html')) return;
  e.preventDefault();
  attachFiles(files, keep);
});

const carriesFiles = (e) => !S.drag && e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const dropElement = (e) => (e.target.nodeType === 1 ? e.target : e.target.parentElement);
const inDrawer = (e) => {
  const el = dropElement(e);
  return !!(S.cardId && !M.kind && el && el.closest('#drawer'));
};
const showDropTarget = (on) => $('#drawer').classList.toggle('drop-on', on);

document.addEventListener('dragover', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault(); // a file let go anywhere else would replace the page with it
  const over = inDrawer(e);
  e.dataTransfer.dropEffect = over ? 'copy' : 'none';
  showDropTarget(over);
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) showDropTarget(false);
});
document.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  showDropTarget(false);
  if (inDrawer(e)) attachFiles([...e.dataTransfer.files], fileField(dropElement(e)));
});

window.addEventListener('hashchange', () => {
  readHash();
  render();
});

// The server sends its versions on every change and every 15 seconds. A stream
// that has gone quiet is dead, whatever the browser says about it: that happens
// when the Mac sleeps or the window sits hidden for hours.
let stream = null;
let lastBeat = 0;
let lastWake = 0;

function connect() {
  if (stream) stream.close();
  const es = (stream = new EventSource('/api/events'));
  es.onmessage = (e) => {
    lastBeat = Date.now();
    S.connected = true;
    let v = 0;
    let diary = 0;
    try {
      const j = JSON.parse(e.data);
      v = j.version;
      diary = j.diary || 0;
    } catch (_) {}
    const news = diary !== S.diary.latest; // the Diary view fetches again when it is the one showing
    if (news) S.diary.latest = diary;
    if (!S.data || v !== S.data.version) loadState().catch(() => {});
    else if (news && S.view === 'diary') render();
    else renderTop();
  };
  es.onerror = () => {
    S.connected = false; // the browser retries on its own; wake() takes over if it gives up
    if (S.data) renderTop();
  };
}

/** Catch up after the window was hidden, the Mac slept, or the stream went quiet. */
function wake() {
  if (Date.now() - lastWake < 3000) return;
  lastWake = Date.now();
  if (!stream || stream.readyState === 2 || Date.now() - lastBeat > 40000) connect();
  loadState().catch(() => {});
}
document.addEventListener('visibilitychange', () => !document.hidden && wake());
window.addEventListener('focus', wake);
window.addEventListener('pageshow', wake);
window.addEventListener('online', wake);

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
  setInterval(() => {
    if (Date.now() - lastBeat > 40000) wake();
  }, 10000);
  // keep "5m ago" honest
  setInterval(() => {
    if (!S.drag && !S.pointerDown && !M.kind && S.view !== 'graph') render();
  }, 60000);
})();
