import { EditorState, Annotation, StateEffect, StateField } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { latexLanguage, latexHighlight, editorTheme, latexCompletions, scanLabels, scanBib } from './latex.js';
import { PdfView } from './pdfview.js';
import { PdfMarks, readPdfSelection } from './pdfmarks.js';
import { computeChanges, keepChange, undoChange, describe, sectionAt, markedText, excerpts } from './review.js';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');
const External = Annotation.define();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem('underleaf:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('underleaf:' + k, JSON.stringify(v)); } catch {} },
};

const app = {
  root: '', name: '', main: null, files: [], current: null,
  docs: new Map(), // path -> { state, seq, dirty, timer, scroll, binary }
  compile: null, pdfVersion: -1, citations: [],
  reviews: new Map(), // path -> { base }: the text from before outside edits (Claude) that are not reviewed yet
  diskText: new Map(), // latest text of edited files that aren't loaded in the editor
  reviewGroups: [], lastTyped: 0,
  texpresso: false, live: false, liveSending: false, resumeLive: false, lastTermOut: 0,
  claudeOpen: store.get('claudeOpen', true), terminalStarted: false, terminalStartedAt: 0, terminalExited: false,
};

// ------------------------------------------------------------------ connection

let ws = null;
const handlers = {};
const pending = new Map();
const outbox = [];

function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  else if (msg.type === 'save') outbox.push(msg);
}

const rpcWaiters = new Map();
let rpcSeq = 0;
function rpc(msg, timeout = 3000) {
  return new Promise((resolve) => {
    if (ws?.readyState !== 1) return resolve(null);
    const rid = ++rpcSeq;
    const timer = setTimeout(() => { rpcWaiters.delete(rid); resolve(null); }, timeout);
    rpcWaiters.set(rid, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ ...msg, rid }));
  });
}

function request(msg, replyType) {
  return new Promise((resolve) => {
    const key = `${replyType}:${msg.path}`;
    if (!pending.has(key)) pending.set(key, []);
    pending.get(key).push(resolve);
    send(msg);
  });
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?t=${token}`);
  ws.onopen = () => {
    $('app').classList.remove('offline');
    send({ type: 'hello' });
    while (outbox.length) send(outbox.shift());
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'rpc') {
      rpcWaiters.get(m.rid)?.(m);
      rpcWaiters.delete(m.rid);
      return;
    }
    const key = `${m.type}:${m.path}`;
    const waiting = pending.get(key);
    if (waiting?.length) {
      waiting.shift()(m);
      if (!waiting.length) pending.delete(key);
      return;
    }
    handlers[m.type]?.(m);
  };
  ws.onclose = () => {
    $('app').classList.add('offline');
    setTimeout(connect, 1200);
  };
}

// ------------------------------------------------------------------ editor

const flashEffect = StateEffect.define();
const clearFlashEffect = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearFlashEffect)) deco = Decoration.none;
      if (e.is(flashEffect)) {
        const doc = tr.state.doc;
        const first = doc.lineAt(clamp(e.value.from, 0, doc.length)).number;
        const last = Math.min(doc.lineAt(clamp(e.value.to, 0, doc.length)).number, first + 300);
        const ranges = [];
        for (let n = first; n <= last; n++) ranges.push(Decoration.line({ class: 'cm-flash-line' }).range(doc.line(n).from));
        deco = Decoration.set(ranges);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

let flashTimer = null;
function flash(from, to) {
  view.dispatch({ effects: flashEffect.of({ from, to }) });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => view.dispatch({ effects: clearFlashEffect.of(null) }), 1400);
}

const completionContext = () => {
  const labels = new Set();
  for (const [p] of app.docs) if (/\.(tex|ltx)$/.test(p)) for (const l of scanLabels(docText(p))) labels.add(l);
  return { labels: [...labels].sort(), citations: app.citations };
};

function makeState(path, content) {
  const isTex = /\.(tex|ltx|sty|cls|bib|tikz)$/i.test(path);
  return EditorState.create({
    doc: content,
    extensions: [
      keymap.of([
        { key: 'Mod-s', run: () => { recompile(); return true; } },
        { key: 'Mod-Enter', run: () => { recompile(); return true; } },
        { key: 'Mod-k', run: () => { openAsk(); return true; } },
        { key: 'Alt-Enter', run: () => { forwardSync(); return true; } },
      ]),
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(),
      drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
      bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(), highlightActiveLine(),
      highlightSelectionMatches(), lintGutter(), search({ top: false }), EditorView.lineWrapping, indentUnit.of('  '),
      autocompletion({ override: isTex ? [latexCompletions(completionContext)] : [], icons: false }),
      isTex ? [latexLanguage, latexHighlight] : [],
      editorTheme, flashField, reviewMarks,
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => onEditorUpdate(path, u)),
    ],
  });
}

const view = new EditorView({ parent: $('editor'), state: EditorState.create({ doc: '' }) });

function docText(path) {
  const d = app.docs.get(path);
  if (!d || d.binary) return '';
  return (path === app.current ? view.state : d.state).doc.toString();
}

function onEditorUpdate(path, u) {
  if (!u.docChanged) return;
  const d = app.docs.get(path);
  if (!d) return;
  const local = u.transactions.filter((tr) => tr.docChanged && !tr.annotation(External));
  if (!local.length) return;
  if (local.some((tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'))) app.lastTyped = Date.now();
  if (app.reviews.has(path)) scheduleReviewRefresh();
  if (app.liveSending && !d.liveSynced) {
    // TeXpresso hasn't seen this file from the editor yet: send it whole.
    send({ type: 'live-open', path, content: u.state.doc.toString() });
    d.liveSynced = true;
  } else if (app.liveSending) {
    for (const tr of local) {
      const changes = [];
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const a = tr.startState.doc.lineAt(fromA);
        const b = tr.startState.doc.lineAt(toA);
        changes.push([a.number - 1, fromA - a.from, b.number - 1, toA - b.from, inserted.toString()]);
      });
      send({ type: 'live-change', path, changes: changes.reverse() });
    }
  }
  d.dirty = true;
  setSaveState('dirty');
  clearTimeout(d.timer);
  d.timer = setTimeout(() => save(path), 180);
}

function save(path, immediate = false) {
  const d = app.docs.get(path);
  if (!d || d.binary) return;
  clearTimeout(d.timer);
  d.seq++;
  send({ type: 'save', path, content: docText(path), seq: d.seq, immediate });
}

function flushSaves() {
  for (const [p, d] of app.docs) if (d.dirty) save(p, true);
}

handlers.saved = (m) => {
  const d = app.docs.get(m.path);
  if (d && m.seq >= d.seq) d.dirty = false;
  if (![...app.docs.values()].some((x) => x.dirty)) setSaveState('saved');
};

function setSaveState(s) {
  const el = $('save-state');
  el.dataset.state = s;
  el.textContent = s === 'saved' ? 'Saved' : 'Saving…';
}

function recompile() {
  flushSaves();
  send({ type: 'compile' });
}

async function openFile(path, { focus = true, restoreScroll = true } = {}) {
  if (!path) return;
  if (app.current === path) return;
  const prev = app.docs.get(app.current);
  if (prev && !prev.binary) { prev.state = view.state; prev.scroll = view.scrollDOM.scrollTop; }

  let d = app.docs.get(path);
  if (!d) {
    const m = await request({ type: 'open', path }, 'opened');
    if (m.binary) d = { binary: true };
    else d = { state: makeState(path, m.content), seq: 0, dirty: false, scroll: 0 };
    app.docs.set(path, d);
  }
  app.current = path;
  store.set(`lastFile:${app.root}`, path);
  $('file-name').textContent = path;
  $('image-view').hidden = !d.binary;
  $('editor').hidden = !!d.binary;
  if (d.binary) {
    const isImage = /\.(png|jpe?g|gif|svg|webp)$/i.test(path);
    $('image-view').innerHTML = isImage
      ? `<img alt="${escapeHtml(path)}" src="/raw?t=${token}&p=${encodeURIComponent(path)}">`
      : `<p>${escapeHtml(path)} is not a text file, so it can't be edited here.</p>`;
  } else {
    view.setState(d.state);
    applyDiagnostics();
    if (restoreScroll) requestAnimationFrame(() => { view.scrollDOM.scrollTop = d.scroll || 0; });
    if (focus) view.focus();
    markEditorChanges();
  }
  renderTree();
}

// ------------------------------------------------------------------ reviewing outside edits (Claude)
// When a file changes on disk (Claude editing it), keep the text from before and list every change
// in a review panel as a before/after card. Keep or undo each change, or all of them at once.

const setReviewMarks = StateEffect.define();
const reviewMarks = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setReviewMarks)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function minimalChange(old, next) {
  let start = 0;
  const min = Math.min(old.length, next.length);
  while (start < min && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endOld = old.length, endNew = next.length;
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === next.charCodeAt(endNew - 1)) { endOld--; endNew--; }
  return { from: start, to: endOld, insert: next.slice(start, endNew) };
}

const stateOf = (path) => (path === app.current ? view.state : app.docs.get(path)?.state);

function currentText(path) {
  const d = app.docs.get(path);
  if (d && !d.binary) return stateOf(path).doc.toString();
  return app.diskText.get(path) ?? null;
}

function applyExternal(path, content, previous = null) {
  const d = app.docs.get(path);
  if (d?.binary) return;
  const before = d ? stateOf(path).doc.toString() : previous;
  if (before === content) return;
  if (before != null && !app.reviews.has(path)) app.reviews.set(path, { base: before });
  if (d) {
    const st = stateOf(path);
    const spec = { changes: minimalChange(st.doc.toString(), content), annotations: External.of(true) };
    clearTimeout(d.timer);
    d.dirty = false;
    if (path === app.current) view.dispatch(spec);
    else d.state = st.update(spec).state;
    if (app.liveSending) {
      send({ type: 'live-open', path, content });
      d.liveSynced = true;
    }
  } else {
    app.diskText.set(path, content);
  }
  refreshReview();
  // Show the changes right away, unless the user is in the middle of typing.
  if (app.reviews.has(path) && Date.now() - app.lastTyped > 3000) openReview();
}

// Replace a file's text as if the user edited it: saved to disk and recompiled.
function setFileText(path, text) {
  const d = app.docs.get(path);
  if (d && !d.binary) {
    const st = stateOf(path);
    const spec = { changes: minimalChange(st.doc.toString(), text) };
    if (path === app.current) view.dispatch(spec);
    else {
      d.state = st.update(spec).state;
      d.dirty = true;
      save(path, true);
    }
  } else {
    app.diskText.set(path, text);
    send({ type: 'save', path, content: text, seq: 0, immediate: true });
  }
}

let reviewTimer = null;
function scheduleReviewRefresh() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(refreshReview, 250);
}

function refreshReview() {
  clearTimeout(reviewTimer);
  const groups = [];
  for (const [path, r] of app.reviews) {
    const cur = currentText(path);
    if (cur == null) continue;
    const hunks = computeChanges(r.base, cur);
    if (hunks.length) groups.push({ path, base: r.base, cur, hunks });
    else app.reviews.delete(path);
  }
  app.reviewGroups = groups;
  const total = groups.reduce((n, g) => n + g.hunks.length, 0);
  $('btn-review').hidden = !total;
  $('btn-review-count').textContent = total;
  if (!total) closeReview();
  else if (!$('review').hidden) renderReview();
  renderTree();
  markEditorChanges();
  scheduleChangeBars();
}

function openReview() {
  if (!app.reviewGroups.length) return;
  $('review').hidden = false;
  renderReview();
}

function closeReview() {
  $('review').hidden = true;
}

function renderReview() {
  const groups = app.reviewGroups;
  const total = groups.reduce((n, g) => n + g.hunks.length, 0);
  $('rv-count').textContent = `${total} change${total === 1 ? '' : 's'}`;
  $('rv-files').textContent = `in ${groups.map((g) => g.path).join(', ')}`;
  const list = $('rv-list');
  const scroll = list.scrollTop;
  const cards = groups.map((g) => g.hunks.map((h) => changeCard(g, h)));
  list.replaceChildren(
    ...(total > 3 ? [overview(groups, cards)] : []),
    ...groups.flatMap((g, i) => [fileHeading(g), ...cards[i]]),
  );
  list.scrollTop = scroll;
}

// One row per change, so everything that changed is visible at once.
function overview(groups, cards) {
  const nav = document.createElement('nav');
  nav.className = 'rv-overview';
  groups.forEach((g, gi) => g.hunks.forEach((h, hi) => {
    const info = describe(h);
    const row = document.createElement('button');
    row.className = `rv-ov-row ${info.kind}`;
    const dot = document.createElement('span');
    dot.className = 'rv-dot';
    const where = document.createElement('span');
    where.className = 'rv-ov-where';
    const section = sectionAt(g.cur, h.fromB);
    where.textContent = `${groups.length > 1 ? `${g.path} · ` : ''}${section ? `${section} · ` : ''}${h.lineB}`;
    const text = document.createElement('span');
    text.className = 'rv-ov-text';
    text.textContent = info.text;
    row.append(dot, where, text);
    row.onclick = () => {
      const card = cards[gi][hi];
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.remove('pulse');
      void card.offsetWidth;
      card.classList.add('pulse');
    };
    nav.append(row);
  }));
  return nav;
}

function fileHeading(g) {
  const el = document.createElement('div');
  el.className = 'rv-file';
  const name = document.createElement('span');
  name.textContent = g.path;
  const count = document.createElement('span');
  count.className = 'rv-file-count';
  count.textContent = `${g.hunks.length} change${g.hunks.length === 1 ? '' : 's'}`;
  el.append(name, count);
  return el;
}

function changeCard(g, h) {
  const info = describe(h);
  const card = document.createElement('article');
  card.className = `rv-card ${info.kind}`;
  card.innerHTML = `
    <header class="rv-card-head">
      <span class="rv-badge"></span><span class="rv-where"></span>
      <div class="spacer"></div>
      <button class="rv-link" data-act="pdf">Show in PDF</button>
      <button class="rv-link" data-act="edit">Edit</button>
      <button class="btn small" data-act="undo">Undo</button>
      <button class="btn small keep" data-act="keep">Keep</button>
    </header>
    <p class="rv-summary"></p>
    <div class="rv-diff"></div>`;
  const section = sectionAt(g.cur, h.fromB);
  const lines = h.lineEndB > h.lineB ? `lines ${h.lineB}–${h.lineEndB}` : `line ${h.lineB}`;
  card.querySelector('.rv-badge').textContent = info.label;
  card.querySelector('.rv-where').textContent = section ? `${section} · ${lines}` : lines;
  card.querySelector('.rv-summary').textContent = info.text;
  const diff = card.querySelector('.rv-diff');
  const delRanges = h.changes.map((c) => ({ from: c.fromA, to: c.toA }));
  const insRanges = h.changes.map((c) => ({ from: c.fromB, to: c.toB }));
  const windows = excerpts(h);
  const renderSides = (full) => {
    const aw = full || !windows ? null : windows.map((w) => w.a);
    const bw = full || !windows ? null : windows.map((w) => w.b);
    diff.replaceChildren(
      ...(h.before ? [diffSide('Before', 'before', excerptText(h.before, delRanges, 'rv-del', aw))] : []),
      ...(h.after ? [diffSide('After', 'after', excerptText(h.after, insRanges, 'rv-ins', bw))] : []),
    );
    // Whole added/removed blocks can be long too: clamp them.
    const long = !windows && (h.before.length > 700 || h.after.length > 700);
    for (const t of diff.querySelectorAll('.rv-text')) t.classList.toggle('clamped', long && !full);
  };
  renderSides(false);
  if (windows || h.before.length > 700 || h.after.length > 700) {
    const more = document.createElement('button');
    more.className = 'rv-more';
    more.textContent = 'Show full text';
    let full = false;
    more.onclick = () => {
      full = !full;
      renderSides(full);
      more.textContent = full ? 'Show less' : 'Show full text';
    };
    card.append(more);
  }

  // Acting on a card only makes sense if the file hasn't moved on since it was drawn.
  const fresh = () => {
    const r = app.reviews.get(g.path);
    if (r && r.base === g.base && currentText(g.path) === g.cur) return r;
    refreshReview();
    return null;
  };
  card.querySelector('[data-act=keep]').onclick = () => {
    const r = fresh();
    if (!r) return;
    r.base = keepChange(r.base, g.cur, h);
    refreshReview();
  };
  card.querySelector('[data-act=undo]').onclick = () => {
    const r = fresh();
    if (!r) return;
    setFileText(g.path, undoChange(r.base, g.cur, h));
    refreshReview();
  };
  card.querySelector('[data-act=pdf]').onclick = () => showChangeInPdf(g.path, h);
  card.querySelector('[data-act=edit]').onclick = () => {
    closeReview();
    revealLines(g.path, h.lineB, h.lineEndB);
  };
  return card;
}

// The marked text, or only the given windows of it joined by an ellipsis.
function excerptText(text, ranges, cls, windows) {
  if (!windows) return markedText(text, ranges, cls);
  const frag = document.createDocumentFragment();
  windows.forEach((w, i) => {
    if (i > 0) frag.append(Object.assign(document.createElement('span'), { className: 'rv-gap', textContent: ' … ' }));
    else if (w.from > 0) frag.append(Object.assign(document.createElement('span'), { className: 'rv-gap', textContent: '… ' }));
    const local = ranges.map((r) => ({ from: r.from - w.from, to: r.to - w.from })).filter((r) => r.to > 0 && r.from < w.to - w.from);
    frag.append(markedText(text.slice(w.from, w.to), local.map((r) => ({ from: Math.max(0, r.from), to: r.to })), cls));
    if (i === windows.length - 1 && w.to < text.length) frag.append(Object.assign(document.createElement('span'), { className: 'rv-gap', textContent: ' …' }));
  });
  return frag;
}

function diffSide(label, cls, content) {
  const el = document.createElement('div');
  el.className = `rv-side ${cls}`;
  const tag = document.createElement('span');
  tag.className = 'rv-label';
  tag.textContent = label;
  const text = document.createElement('div');
  text.className = 'rv-text';
  text.append(content);
  el.append(tag, text);
  return el;
}

async function showChangeInPdf(path, h) {
  const r = await rpc({ type: 'link-from-source', path, line: h.lineB });
  if (r?.page != null) pdfView.scrollToPoint(r.page, r.x, r.y, r.h);
  else toast("That change isn't in the compiled PDF yet.");
}

// Changed lines get a green edge in the editor; a red line marks where text was removed.
function markEditorChanges() {
  const d = app.docs.get(app.current);
  if (!d || d.binary) return;
  const doc = view.state.doc;
  const g = app.reviewGroups.find((x) => x.path === app.current);
  const ranges = [];
  if (g && g.cur === doc.toString()) {
    for (const h of g.hunks) {
      if (h.after) {
        for (let n = h.lineB; n <= h.lineEndB; n++) ranges.push(Decoration.line({ class: 'cm-rv-changed' }).range(doc.line(n).from));
      } else {
        ranges.push(Decoration.line({ class: 'cm-rv-removed' }).range(doc.line(Math.min(h.lineB, doc.lines)).from));
      }
    }
  }
  view.dispatch({ effects: setReviewMarks.of(Decoration.set(ranges, true)) });
}

// Green bars in the PDF margin next to every changed passage.
let barsTimer = null;
function scheduleChangeBars(delay = 300) {
  clearTimeout(barsTimer);
  barsTimer = setTimeout(updateChangeBars, delay);
}

async function updateChangeBars() {
  const bars = [];
  for (const g of app.reviewGroups) {
    for (const h of g.hunks.slice(0, 80)) {
      const [ra, rb] = await Promise.all([
        rpc({ type: 'link-from-source', path: g.path, line: h.lineB }),
        h.lineEndB > h.lineB ? rpc({ type: 'link-from-source', path: g.path, line: h.lineEndB }) : null,
      ]);
      if (ra?.page == null) continue;
      const same = rb?.page === ra.page;
      bars.push({
        page: ra.page,
        x: same ? Math.min(ra.x, rb.x) : ra.x,
        top: same ? Math.min(ra.y, rb.y) : ra.y,
        bottom: Math.max(ra.y + (ra.h || 10), same ? rb.y + (rb.h || 10) : 0),
      });
    }
  }
  pdfView.setChangeBars(bars);
}

$('btn-review').onclick = () => ($('review').hidden ? openReview() : closeReview());
$('rv-close').onclick = () => { closeReview(); view.focus(); };
$('rv-keep-all').onclick = () => {
  app.reviews.clear();
  refreshReview();
};
$('rv-undo-all').onclick = () => {
  for (const [path, r] of app.reviews) setFileText(path, r.base);
  app.reviews.clear();
  refreshReview();
};

handlers['file-changed'] = (m) => {
  if (m.path.endsWith('.bib')) loadCitations();
  applyExternal(m.path, m.content, m.previous);
};

handlers['file-deleted'] = (m) => {
  if (app.reviews.delete(m.path)) refreshReview();
  if (app.current === m.path) toast(`${m.path} was deleted on disk. The editor still has its last contents.`);
};

async function revealLines(path, from, to = from, { focus = true, select = true } = {}) {
  if (!app.files.includes(path)) return;
  await openFile(path, { focus, restoreScroll: false });
  if (app.docs.get(path)?.binary) return;
  const doc = view.state.doc;
  const a = doc.line(clamp(from, 1, doc.lines));
  const b = doc.line(clamp(to, from, doc.lines));
  view.dispatch({
    ...(select && { selection: { anchor: a.from } }),
    effects: EditorView.scrollIntoView(a.from, { y: 'center' }),
  });
  flash(a.from, b.to);
  if (focus) view.focus();
}
const gotoLine = (path, line) => revealLines(path, line);
handlers.goto = (m) => gotoLine(m.path, m.line);

function forwardSync() {
  if (!app.current || app.docs.get(app.current)?.binary) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  if (app.live) send({ type: 'live-forward', path: app.current, line });
  else send({ type: 'sync-forward', path: app.current, line });
}

// ------------------------------------------------------------------ diagnostics & compile status

function applyDiagnostics() {
  if (!app.current || !app.compile) return;
  const doc = view.state.doc;
  const items = [...app.compile.errors, ...app.compile.warnings].filter((e) => e.file === app.current && e.line);
  const diagnostics = items.map((e) => {
    const l = doc.line(clamp(e.line, 1, doc.lines));
    const from = l.from + (l.text.length - l.text.trimStart().length);
    return { from, to: Math.max(from, l.to), severity: e.severity, message: e.message, source: 'LaTeX' };
  });
  view.dispatch(setDiagnostics(view.state, diagnostics));
}

let pdfView;
handlers['compile-start'] = () => {
  $('preview').classList.add('compiling');
  setStatus('busy', 'Compiling…');
};
handlers['compile-note'] = (m) => setStatus('busy', m.text);
handlers['compile-done'] = (m) => onCompileDone(m);

async function onCompileDone(m) {
  app.compile = m;
  $('preview').classList.remove('compiling');
  const nErr = m.errors.length, nWarn = m.warnings.length;
  const secs = (m.ms / 1000).toFixed(m.ms < 10000 ? 2 : 1);
  if (nErr) setStatus('error', m.version > 0 ? `Compiled with errors · ${secs}s` : 'Compile failed');
  else setStatus('ok', `Compiled in ${secs}s`);
  const chip = $('btn-issues');
  chip.hidden = !nErr && !nWarn;
  chip.dataset.level = nErr ? 'error' : 'warning';
  chip.textContent = [nErr && `${nErr} error${nErr > 1 ? 's' : ''}`, nWarn && `${nWarn} warning${nWarn > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
  $('chip-fix').disabled = !nErr;
  applyDiagnostics();
  renderIssues();
  if (m.version > 0 && m.version !== app.pdfVersion) {
    app.pdfVersion = m.version;
    const ok = await pdfView.load(`/pdf?t=${token}&v=${m.version}`);
    if (ok) $('pdf-empty').hidden = true;
    if (ok && app.reviews.size) scheduleChangeBars(0);
  } else if (m.version === 0 && nErr) {
    $('pdf-empty').hidden = false;
    $('pdf-empty-text').textContent = 'The first compile failed. Open the error list to see why.';
  }
}

function setStatus(kind, text) {
  $('compile-status').dataset.kind = kind;
  $('compile-text').textContent = text;
}

function renderIssues() {
  const m = app.compile;
  if (!m) return;
  const list = $('issues-list');
  list.innerHTML = '';
  const all = [...m.errors, ...m.warnings];
  $('issues-title').textContent = all.length ? $('btn-issues').textContent : 'No errors or warnings';
  for (const e of all) {
    const row = document.createElement('button');
    row.className = `issue ${e.severity}`;
    const where = e.file ? `${e.file}${e.line ? ':' + e.line : ''}` : e.rawFile ? `${e.rawFile}:${e.line}` : '';
    row.innerHTML = `<i></i><span class="issue-where">${escapeHtml(where)}</span><span class="issue-msg">${escapeHtml(e.message)}</span>`;
    if (e.file && e.line) row.onclick = () => gotoLine(e.file, e.line);
    else row.disabled = true;
    list.appendChild(row);
  }
  $('raw-log').textContent = m.rawOutput || '';
}

// ------------------------------------------------------------------ file tree

const collapsed = new Set(store.get('collapsed', []));
const ICON = {
  tex: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 8.5h5M6 11h3.5" stroke="currentColor" stroke-width="1.2"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M5.5 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};
const fileKind = (p) => (/\.(tex|ltx)$/i.test(p) ? 'tex' : /\.bib$/i.test(p) ? 'bib' : /\.(png|jpe?g|pdf|svg|eps|gif)$/i.test(p) ? 'img' : /\.(sty|cls)$/i.test(p) ? 'sty' : 'other');

function renderTree() {
  const tree = { dirs: new Map(), files: [] };
  for (const f of app.files) {
    const parts = f.split('/');
    let node = tree;
    for (const dir of parts.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push(f);
  }
  const root = $('file-tree');
  root.innerHTML = '';
  const walk = (node, prefix, depth) => {
    for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      const full = prefix + name;
      const row = document.createElement('button');
      row.className = 'tree-row dir' + (collapsed.has(full) ? ' collapsed' : '');
      row.style.setProperty('--depth', depth);
      row.innerHTML = `<span class="chev">${ICON.folder}</span><span class="tree-name">${escapeHtml(name)}</span>`;
      row.onclick = () => {
        collapsed.has(full) ? collapsed.delete(full) : collapsed.add(full);
        store.set('collapsed', [...collapsed]);
        renderTree();
      };
      root.appendChild(row);
      if (!collapsed.has(full)) walk(child, full + '/', depth + 1);
    }
    for (const f of node.files) {
      const name = f.split('/').pop();
      const kind = fileKind(f);
      const row = document.createElement('div');
      const inReview = app.reviews.has(f);
      row.className = `tree-row file kind-${kind}` + (f === app.current ? ' active' : '') + (f === app.main ? ' is-main' : '') + (inReview ? ' has-review' : '');
      row.style.setProperty('--depth', depth);
      row.tabIndex = 0;
      row.innerHTML = `<span class="ficon">${ICON.tex}</span><span class="tree-name">${escapeHtml(name)}</span>` +
        (f === app.main ? '<span class="main-badge" title="Compiled as the main document">main</span>'
          : kind === 'tex' ? '<button class="set-main" title="Compile this file as the main document">set main</button>' : '');
      row.onclick = (e) => {
        if (e.target.closest('.set-main')) { send({ type: 'set-main', path: f }); return; }
        openFile(f);
      };
      row.onkeydown = (e) => { if (e.key === 'Enter') openFile(f); };
      root.appendChild(row);
    }
  };
  walk(tree, '', 0);
}

handlers.files = (m) => {
  app.files = m.files;
  const mainChanged = app.main !== m.main;
  app.main = m.main;
  renderTree();
  if (mainChanged) {
    app.pdfVersion = -1;
    pdfView.clear();
    $('pdf-empty').hidden = false;
    $('pdf-empty-text').textContent = 'Setting the first proof…';
  }
  loadCitations();
};

$('btn-new-file').onclick = async () => {
  const p = prompt('New file path, relative to the project (e.g. sections/intro.tex)');
  if (!p) return;
  const m = await request({ type: 'create', path: p.trim() }, 'created');
  app.files = [...new Set([...app.files, m.path])].sort();
  openFile(m.path);
};

let citeTimer = null;
function loadCitations() {
  clearTimeout(citeTimer);
  citeTimer = setTimeout(async () => {
    const out = [];
    for (const f of app.files.filter((x) => x.endsWith('.bib'))) {
      const m = await request({ type: 'open', path: f }, 'opened');
      if (m.content) out.push(...scanBib(m.content));
    }
    app.citations = out;
  }, 300);
}

// ------------------------------------------------------------------ PDF preview

pdfView = new PdfView($('pdf'), $('pdf-pages'), {
  onSyncClick: (page, x, y) => send({ type: 'sync-backward', page, x, y }),
  onPageChange: (page, total) => { $('page-indicator').textContent = total ? `${page} / ${total}` : ''; },
  onZoomChange: (label) => { $('zoom-label').textContent = label; },
  onTextLayer: (index) => marks.drawPage(index),
});

// ------------------------------------------------------------------ PDF selection, highlights

const marks = new PdfMarks(pdfView, {
  onChange: () => {
    const n = marks.count;
    $('hl-group').hidden = !n;
    $('hl-count').textContent = `${n} highlight${n === 1 ? '' : 's'}`;
    if (app.root) store.set(`highlights:${app.root}`, marks.serialize());
  },
});

const quote = (t, max = 400) => `"${t.length > max ? t.slice(0, max) + '…' : t}"`;
const srcLabel = (src) => (src?.path ? `${src.path} ${src.from === src.to ? `line ${src.from}` : `lines ${src.from}–${src.to}`}` : '');
const selectionSource = (sel) => rpc({ type: 'sync-range', a: sel.start, b: sel.end }).then((r) => (r?.path ? r : null));

let tools = null; // { mode: 'selection', sel } | { mode: 'mark', id }
function showTools(anchor, state) {
  tools = state;
  const box = $('pdf-tools');
  $('pt-mark').hidden = state.mode !== 'selection';
  $('pt-remove').hidden = state.mode !== 'mark';
  box.hidden = false;
  const r = box.getBoundingClientRect();
  const pane = $('pdf').getBoundingClientRect();
  let top = anchor.top - r.height - 8;
  if (top < pane.top + 4) top = anchor.bottom + 8;
  box.style.left = `${clamp(anchor.left, pane.left + 6, pane.right - r.width - 6)}px`;
  box.style.top = `${clamp(top, pane.top + 4, pane.bottom - r.height - 4)}px`;
}
function hideTools() {
  tools = null;
  $('pdf-tools').hidden = true;
}

$('pdf-pages').addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  setTimeout(() => {
    const sel = readPdfSelection(pdfView);
    if (sel) return showTools(sel.anchor, { mode: 'selection', sel });
    const hit = marks.hitTest(e.clientX, e.clientY);
    if (hit) return showTools(hit.rect, { mode: 'mark', id: hit.id });
    hideTools();
  }, 0);
});
$('pdf-tools').addEventListener('mousedown', (e) => e.preventDefault()); // keep the PDF selection
$('pdf').addEventListener('scroll', () => { if (tools) hideTools(); }, { passive: true });
document.addEventListener('mousedown', (e) => { if (tools && !e.target.closest('#pdf-tools, #pdf-pages')) hideTools(); });

const markById = (id) => marks.items.find((it) => it.id === id);

$('pt-ask').onclick = () => {
  const state = tools;
  hideTools();
  if (state?.mode === 'selection') askAboutPdfSelection(state.sel);
  else if (state?.mode === 'mark') { const it = markById(state.id); if (it) askAboutHighlights([it]); }
};
$('pt-mark').onclick = async () => {
  const sel = tools?.sel;
  hideTools();
  if (!sel) return;
  window.getSelection().removeAllRanges();
  marks.add(sel.parts, await selectionSource(sel));
};
$('pt-source').onclick = async () => {
  const state = tools;
  hideTools();
  let src = null;
  if (state?.mode === 'selection') src = await selectionSource(state.sel);
  else if (state?.mode === 'mark') src = markById(state.id)?.src;
  if (src) revealLines(src.path, src.from, src.to);
  else toast('Could not find this passage in the source yet. Recompile and try again.');
};
$('pt-remove').onclick = () => {
  const state = tools;
  hideTools();
  if (state?.mode === 'mark') marks.remove(state.id);
};
$('hl-ask').onclick = () => askAboutHighlights(marks.items);
$('hl-clear').onclick = () => marks.clear();

async function askAboutPdfSelection(sel) {
  window.getSelection().removeAllRanges();
  marks.setTemp(sel.parts);
  const page = sel.start.page;
  const target = {
    label: `PDF page ${page} · finding the source…`,
    anchor: sel.anchor,
    message: (q) => `About this passage in the PDF (page ${page}${target.src ? `, source ${srcLabel(target.src)}` : ''}): ${quote(sel.text)}. ${q}`,
  };
  showAsk(target);
  const src = await selectionSource(sel);
  if (askTarget !== target) return;
  target.src = src;
  $('ask-context').textContent = src ? `PDF page ${page} · ${srcLabel(src)}` : `PDF page ${page}`;
  if (src) revealLines(src.path, src.from, src.to, { focus: false, select: false });
}

function askAboutHighlights(items) {
  if (!items.length) return;
  const anchorEl = $('hl-group').hidden ? $('pdf') : $('hl-group');
  const r = anchorEl.getBoundingClientRect();
  showAsk({
    label: items.length === 1 ? `Highlight · ${srcLabel(items[0].src) || `page ${items[0].page + 1}`}` : `${items.length} highlights`,
    anchor: { left: r.left, top: r.top, bottom: r.bottom },
    message: (q) => {
      const list = items.map((it, i) => `[${i + 1}] ${srcLabel(it.src) || `PDF page ${it.page + 1}`}: ${quote(it.text, 300)}`).join(' ');
      return `About ${items.length === 1 ? 'this passage' : 'these passages'} I highlighted in the PDF: ${list}. ${q}`;
    },
  });
}

// ------------------------------------------------------------------ linked scrolling

app.scrollLink = store.get('scrollLink', false);
function setScrollLink(on) {
  app.scrollLink = on;
  store.set('scrollLink', on);
  $('btn-link').classList.toggle('on', on);
  $('btn-link').setAttribute('aria-pressed', on);
}
$('btn-link').onclick = () => setScrollLink(!app.scrollLink);
setScrollLink(app.scrollLink);

// Whichever pane the user last touched drives; programmatic scrolls of the other pane are ignored.
let scrollDriver = null;
let driverTimer = null;
function drive(who) {
  scrollDriver = who;
  clearTimeout(driverTimer);
  driverTimer = setTimeout(() => { scrollDriver = null; }, 600);
}
for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart']) {
  $('pdf').addEventListener(type, () => drive('pdf'), { passive: true });
  view.scrollDOM.addEventListener(type, () => drive('editor'), { passive: true });
}

const linking = { pdf: { busy: false, again: false }, editor: { busy: false, again: false } };
function linkedScroll(from) {
  if (!app.scrollLink || app.live || scrollDriver !== from) return;
  drive(from);
  const st = linking[from];
  if (st.busy) { st.again = true; return; }
  st.busy = true;
  requestAnimationFrame(async () => {
    try {
      await (from === 'pdf' ? followPdf() : followEditor());
    } finally {
      st.busy = false;
      if (st.again) { st.again = false; linkedScroll(from); }
    }
  });
}
$('pdf').addEventListener('scroll', () => linkedScroll('pdf'), { passive: true });
view.scrollDOM.addEventListener('scroll', () => linkedScroll('editor'), { passive: true });

async function followPdf() {
  const at = pdfView.readingPoint(0.3);
  if (!at) return;
  const r = await rpc({ type: 'link-from-pdf', page: at.page, frac: at.frac });
  if (!r?.path || scrollDriver !== 'pdf' || !app.files.includes(r.path)) return;
  if (r.path !== app.current) await openFile(r.path, { focus: false, restoreScroll: false });
  if (app.docs.get(r.path)?.binary) return;
  const doc = view.state.doc;
  const pos = doc.line(clamp(r.line, 1, doc.lines)).from;
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: Math.round(view.scrollDOM.clientHeight * 0.3) }) });
}

async function followEditor() {
  if (!app.current || app.docs.get(app.current)?.binary || !pdfView.pages.length) return;
  const top = view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.clientHeight * 0.3;
  const line = view.state.doc.lineAt(view.lineBlockAtHeight(top - view.documentTop).from).number;
  const r = await rpc({ type: 'link-from-source', path: app.current, line });
  if (r?.page == null || scrollDriver !== 'editor') return;
  pdfView.scrollToY(r.page, r.y, 0.3);
}
handlers['pdf-goto'] = (m) => pdfView.scrollToPoint(m.page, m.x, m.y, m.h);
$('zoom-in').onclick = () => pdfView.zoomBy(1.15);
$('zoom-out').onclick = () => pdfView.zoomBy(1 / 1.15);
$('zoom-label').onclick = () => pdfView.setZoom('fit');
$('btn-download').href = `/download?t=${token}`;
$('btn-compile').onclick = recompile;
$('btn-sync').onclick = forwardSync;
$('btn-issues').onclick = () => { $('issues-panel').hidden = !$('issues-panel').hidden; };
$('issues-close').onclick = () => { $('issues-panel').hidden = true; };
$('raw-toggle').onclick = () => { $('raw-log').hidden = !$('raw-log').hidden; };
$('issues-fix').onclick = () => { $('issues-panel').hidden = true; fixErrorsWithClaude(); };

// ------------------------------------------------------------------ TeXpresso live window

let dockTimer = null;
let lastRect = '';
function dockRect() {
  const r = $('pdf').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const top = Math.max(0, window.outerHeight - window.innerHeight - side);
  return { x: (window.screenX + side + r.left) * dpr, y: (window.screenY + top + r.top) * dpr, w: r.width * dpr, h: r.height * dpr };
}
function startLive() {
  if (app.liveSending || !app.texpresso) return;
  flushSaves();
  const docs = [];
  for (const [path, d] of app.docs) {
    if (d.binary) continue;
    docs.push({ path, content: docText(path) });
    d.liveSynced = true;
  }
  app.liveSending = true;
  send({ type: 'live-start', rect: dockRect(), docs });
  $('btn-live').classList.add('starting');
}
function stopLive() {
  app.liveSending = false;
  send({ type: 'live-stop' });
}
const toggleLive = () => (app.liveSending ? stopLive() : startLive());

handlers['live-state'] = (m) => {
  app.live = m.running;
  app.liveSending = m.running;
  if (!m.running) for (const d of app.docs.values()) d.liveSynced = false;
  $('btn-live').classList.remove('starting');
  $('btn-live').classList.toggle('on', m.running);
  $('preview').classList.toggle('live', m.running);
  $('live-dock').hidden = !m.running;
  clearInterval(dockTimer);
  lastRect = '';
  if (m.running) {
    dockTimer = setInterval(() => {
      const r = dockRect();
      const key = [r.x, r.y, r.w, r.h].map(Math.round).join(',');
      if (key !== lastRect) { lastRect = key; send({ type: 'live-rect', rect: r }); }
    }, 250);
  }
};
$('btn-live').onclick = toggleLive;
// TeXpresso's window would be left floating on the desktop while Underleaf is minimized: close it, reopen on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.liveSending) {
    app.resumeLive = true;
    stopLive();
  } else if (!document.hidden && app.resumeLive) {
    app.resumeLive = false;
    setTimeout(startLive, 300);
  }
});

// ------------------------------------------------------------------ Claude Code terminal

const term = new Terminal({
  fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
  fontSize: 13, lineHeight: 1.12, cursorBlink: true, scrollback: 10000, allowProposedApi: true,
  theme: {
    background: '#101318', foreground: '#d9dde4', cursor: '#ecc36f', cursorAccent: '#101318',
    selectionBackground: 'rgba(214,166,79,.32)',
    black: '#1c2027', red: '#e76f72', green: '#86c39a', yellow: '#e2b35f', blue: '#7fa7e0', magenta: '#c9a2ec', cyan: '#7ccfc4', white: '#d9dde4',
    brightBlack: '#5f6776', brightRed: '#f08a8c', brightGreen: '#a3d9b3', brightYellow: '#ecc36f', brightBlue: '#9cc0f0', brightMagenta: '#dcbdf5', brightCyan: '#9fe0d6', brightWhite: '#ffffff',
  },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')));

let termOpened = false;
async function ensureTerminal() {
  if (!termOpened) {
    try { await document.fonts.load('13px "JetBrains Mono Variable"'); } catch {}
    term.open($('terminal'));
    termOpened = true;
    term.onData((data) => {
      if (app.terminalExited) {
        if (data === '\r') { app.terminalExited = false; send({ type: 'term-restart', cols: term.cols, rows: term.rows }); }
        return;
      }
      send({ type: 'term-in', data });
    });
    term.onResize(({ cols, rows }) => send({ type: 'term-resize', cols, rows }));
    new ResizeObserver(() => { if (app.claudeOpen) fitTerminal(); }).observe($('terminal'));
  }
  fitTerminal();
  if (!app.terminalStarted && ws?.readyState === 1) {
    app.terminalStarted = true;
    send({ type: 'term-start', cols: term.cols, rows: term.rows });
  }
}
function fitTerminal() {
  try { fitAddon.fit(); } catch {}
}
handlers['term-out'] = (m) => { term.write(m.data); app.lastTermOut = Date.now(); };
handlers['term-replay'] = (m) => { term.reset(); term.write(m.data); };
handlers['term-reset'] = () => term.reset();
handlers['term-started'] = () => { app.terminalExited = false; app.terminalStartedAt = Date.now(); };
handlers['term-exit'] = () => {
  app.terminalExited = true;
  term.write('\r\n\x1b[38;2;214;166;79mClaude exited. Press Enter to start a new session.\x1b[0m\r\n');
};

function setClaudeOpen(open) {
  app.claudeOpen = open;
  store.set('claudeOpen', open);
  $('left').classList.toggle('claude-hidden', !open);
  $('btn-claude').classList.toggle('on', open);
  if (open) requestAnimationFrame(() => ensureTerminal());
}
$('btn-claude').onclick = () => setClaudeOpen(!app.claudeOpen);
$('btn-term-close').onclick = () => { setClaudeOpen(false); view.focus(); };
$('btn-term-restart').onclick = () => { app.terminalExited = false; send({ type: 'term-restart' }); term.focus(); };

async function sendToClaude(text) {
  flushSaves();
  if (!app.claudeOpen) setClaudeOpen(true);
  await ensureTerminal();
  // A fresh Claude session needs a moment to draw its prompt: wait for a lull in its output (max 10s).
  const deadline = Date.now() + 10_000;
  const busy = () => Date.now() - app.terminalStartedAt < 2500 || Date.now() - app.lastTermOut < 400;
  while (Date.now() < deadline && busy()) await new Promise((r) => setTimeout(r, 100));
  send({ type: 'term-in', data: '\x1b[200~' + text.replace(/[\x00-\x1f]/g, ' ') + '\x1b[201~' });
  setTimeout(() => send({ type: 'term-in', data: '\r' }), 150);
  term.focus();
}

function fixErrorsWithClaude() {
  const errs = app.compile?.errors || [];
  if (!errs.length) return;
  const sample = errs.slice(0, 4).map((e) => `${e.file || e.rawFile || '?'}${e.line ? ':' + e.line : ''} ${e.message}`).join('; ');
  sendToClaude(`The LaTeX build of ${app.main} has ${errs.length} error(s): ${sample}. The full list is in .underleaf/errors.txt and the log is in .underleaf/. Please fix them with minimal changes.`);
}
$('chip-fix').onclick = fixErrorsWithClaude;
$('chip-review').onclick = () => {
  if (!app.current) return;
  sendToClaude(`Review ${app.current} for LaTeX mistakes, typos, grammar and unclear writing. List the issues with line numbers first, then ask me before changing anything.`);
};
$('chip-ask').onclick = () => openAsk();

// ------------------------------------------------------------------ Ask Claude (Ctrl+K)

// A target is { label, anchor: {left, top, bottom}, message(question) }.
let askTarget = null;
function showAsk(target) {
  askTarget = target;
  $('ask-context').textContent = target.label;
  const box = $('ask');
  box.hidden = false;
  const rect = box.getBoundingClientRect();
  const a = target.anchor;
  const x = clamp((a?.left ?? 200) - 12, 8, window.innerWidth - rect.width - 8);
  let y = (a?.bottom ?? 200) + 8;
  if (y + rect.height > window.innerHeight - 8) y = (a?.top ?? 200) - rect.height - 8;
  box.style.left = `${x}px`;
  box.style.top = `${clamp(y, 8, window.innerHeight - rect.height - 8)}px`;
  $('ask-input').value = '';
  $('ask-input').focus();
}
function hideAsk({ keepMark = false } = {}) {
  askTarget = null;
  $('ask').hidden = true;
  if (keepMark) setTimeout(() => marks.clearTemp(), 2500);
  else marks.clearTemp();
}

function openAsk() {
  const pdfSel = readPdfSelection(pdfView);
  if (pdfSel) return askAboutPdfSelection(pdfSel);
  if (!app.current || app.docs.get(app.current)?.binary) return;
  const st = view.state;
  const sel = st.selection.main;
  const file = app.current;
  const l1 = st.doc.lineAt(sel.from).number;
  let l2 = st.doc.lineAt(sel.to).number;
  if (!sel.empty && l2 > l1 && st.doc.lineAt(sel.to).from === sel.to) l2--;
  const firstLine = st.sliceDoc(sel.from, sel.to).split('\n').find((s) => s.trim())?.trim().slice(0, 50) || '';
  const coords = view.coordsAtPos(sel.empty ? sel.head : sel.from) || view.coordsAtPos(view.viewport.from);
  showAsk({
    label: sel.empty ? `${file} · line ${l1}` : `${file} · ${l1 === l2 ? `line ${l1}` : `lines ${l1}–${l2}`}`,
    anchor: coords,
    message: (q) => `${sel.empty ? `In ${file} around line ${l1}` : `In ${file} ${l1 === l2 ? `line ${l1}` : `lines ${l1}-${l2}`}${firstLine ? ` (starting "${firstLine}")` : ''}`}: ${q}`,
  });
}
$('ask-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); hideAsk(); view.focus(); }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = $('ask-input').value.trim();
    if (!text || !askTarget) return;
    const message = askTarget.message(text);
    hideAsk({ keepMark: true });
    sendToClaude(message);
  }
});
$('ask-input').addEventListener('blur', () => setTimeout(() => { if (askTarget && document.activeElement !== $('ask-input')) hideAsk(); }, 150));

// ------------------------------------------------------------------ layout: splitters

const root = document.documentElement;
const sizes = store.get('sizes', {});
for (const [k, v] of Object.entries(sizes)) root.style.setProperty(k, v);

for (const g of document.querySelectorAll('.gutter')) {
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging', g.dataset.resize === 'claude' ? 'drag-row' : 'drag-col');
    const ws_ = $('workspace').getBoundingClientRect();
    const left = $('left').getBoundingClientRect();
    const move = (ev) => {
      if (g.dataset.resize === 'sidebar') root.style.setProperty('--sidebar-w', `${clamp(ev.clientX - ws_.left, 150, 420)}px`);
      if (g.dataset.resize === 'preview') root.style.setProperty('--preview-w', `${clamp(ws_.right - ev.clientX, 280, ws_.width - 420)}px`);
      if (g.dataset.resize === 'claude') root.style.setProperty('--claude-h', `${clamp(left.bottom - ev.clientY, 120, left.height - 100)}px`);
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging', 'drag-row', 'drag-col');
      for (const k of ['--sidebar-w', '--preview-w', '--claude-h']) { const v = root.style.getPropertyValue(k); if (v) sizes[k] = v; }
      store.set('sizes', sizes);
      fitTerminal();
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  });
}

// ------------------------------------------------------------------ global keys, toasts, init

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  let handled = true;
  if (mod && !e.shiftKey && key === 's') recompile();
  else if (mod && e.key === '`') {
    setClaudeOpen(!app.claudeOpen);
    if (app.claudeOpen) setTimeout(() => term.focus(), 50);
    else view.focus();
  } else if (mod && e.shiftKey && key === 'l') toggleLive();
  else if (mod && !e.shiftKey && key === 'k' && readPdfSelection(pdfView)) { hideTools(); openAsk(); }
  else if (e.key === 'Escape' && tools) hideTools();
  else if (e.key === 'Escape' && !$('review').hidden && !e.target.closest?.('#ask')) { closeReview(); view.focus(); }
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
  if (e.key === 'Escape' && !$('issues-panel').hidden) $('issues-panel').hidden = true;
}, true);

window.addEventListener('beforeunload', flushSaves);

handlers.toast = (m) => toast(m.text, m.level);
function toast(text, level = 'info', onClick = null) {
  const el = document.createElement(onClick ? 'button' : 'div');
  el.className = `toast ${level}` + (onClick ? ' clickable' : '');
  el.textContent = text;
  if (onClick) el.onclick = () => { el.remove(); onClick(); };
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), onClick ? 9000 : 5000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The page titles itself with a one-off key until the server has found (and restyled) its window.
const winKey = Math.random().toString(36).slice(2, 10);
let titleTimer = null;
handlers['window-ready'] = (m) => {
  clearTimeout(titleTimer);
  document.title = `${app.name} — Underleaf`;
  $('win-controls').hidden = !m.controls;
};
for (const b of document.querySelectorAll('[data-win]')) b.onclick = () => send({ type: 'win', action: b.dataset.win });
document.querySelector('.topbar').addEventListener('dblclick', (e) => {
  if (!$('win-controls').hidden && !e.target.closest('button, a, nav')) send({ type: 'win', action: 'maximize' });
});

handlers.init = async (m) => {
  const first = !app.root;
  Object.assign(app, { root: m.root, name: m.name, files: m.files, main: m.main, texpresso: m.texpresso });
  document.title = `underleaf-window:${winKey}`;
  send({ type: 'window-hello', key: winKey });
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => { document.title = `${m.name} — Underleaf`; }, 8000);
  $('project-name').textContent = m.name;
  $('project-name').title = m.root;
  $('btn-live').hidden = !m.texpresso;
  renderTree();
  loadCitations();
  if (first) marks.load(store.get(`highlights:${m.root}`, []));
  marks.onChange();
  if (first) {
    const last = store.get(`lastFile:${m.root}`, null);
    await openFile(last && m.files.includes(last) ? last : m.main);
  } else {
    // Reconnected: pick up anything that changed while we were away.
    for (const [path, d] of app.docs) {
      if (d.binary || d.dirty) continue;
      const r = await request({ type: 'open', path }, 'opened');
      if (typeof r.content === 'string') applyExternal(path, r.content);
    }
  }
  if (m.compiling) handlers['compile-start']();
  if (m.compile) onCompileDone(m.compile);
  handlers['live-state']({ running: m.live });
  if (!m.claude) $('claude-title').textContent = 'Terminal (claude not found)';
  app.terminalStarted = false;
  setClaudeOpen(app.claudeOpen);
};

setSaveState('saved');
connect();

// handy for debugging from devtools
window.underleaf = { app, view, pdfView, term };
