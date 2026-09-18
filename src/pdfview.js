// A small PDF.js viewer tuned for live recompiles: new versions swap in without
// flicker (pages render off-DOM, then replace the old canvas) and keep scroll position.
// Each page is canvas + highlight layer + selectable text layer.
// legacy build: polyfills newer JS (e.g. Map.getOrInsertComputed) that current Chrome lacks
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.min.mjs';

const GAP = 18;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class PdfView {
  constructor(scroller, container, { onSyncClick, onPageChange, onZoomChange, onTextLayer } = {}) {
    this.scroller = scroller;
    this.container = container;
    this.cb = { onSyncClick, onPageChange, onZoomChange, onTextLayer };
    this.doc = null;
    this.pages = [];
    this.zoom = 'fit';
    this.scale = 1;
    this.loadSeq = 0;
    this.currentPage = 0;
    this.rafPending = false;

    scroller.addEventListener('scroll', () => this.queueRender(), { passive: true });
    new ResizeObserver(() => this.onResize()).observe(scroller);
    scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
    container.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.pdf-page');
      if (!el) return;
      const idx = this.pages.findIndex((p) => p.el === el);
      const r = el.getBoundingClientRect();
      window.getSelection()?.removeAllRanges();
      this.cb.onSyncClick?.(idx + 1, (e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale);
    });
    installSelectionFix();
  }

  async load(url) {
    const seq = ++this.loadSeq;
    let doc;
    try {
      doc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
    } catch (err) {
      if (seq === this.loadSeq) console.warn('pdf load failed', err);
      return false;
    }
    const sizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const v = page.getViewport({ scale: 1 });
      sizes.push({ page, w: v.width, h: v.height });
    }
    if (seq !== this.loadSeq) { doc.destroy(); return false; }

    const anchor = this.captureAnchor();
    const old = this.doc;
    this.doc = doc;
    for (const pg of this.pages) { pg.task?.cancel(); pg.textTask?.cancel(); }
    while (this.pages.length > sizes.length) this.pages.pop().el.remove();
    sizes.forEach((s, i) => {
      let pg = this.pages[i];
      if (!pg) {
        pg = this.makePage();
        this.pages.push(pg);
      }
      Object.assign(pg, { pdfPage: s.page, w: s.w, h: s.h, key: null, textKey: null });
    });
    this.computeScale();
    this.layout();
    this.restoreAnchor(anchor);
    await this.renderVisible();
    if (old) setTimeout(() => old.destroy(), 3000);
    return true;
  }

  makePage() {
    const el = document.createElement('div');
    el.className = 'pdf-page';
    const canvas = document.createElement('canvas');
    const marks = document.createElement('div');
    marks.className = 'hl-layer';
    const changes = document.createElement('div');
    changes.className = 'change-layer';
    const text = document.createElement('div');
    text.className = 'textLayer';
    el.append(canvas, marks, changes, text);
    this.container.appendChild(el);
    return { el, canvas, marks, changes, text, textDivs: [], w: 612, h: 792, key: null, textKey: null, task: null, textTask: null, pdfPage: null };
  }

  computeScale() {
    if (!this.pages.length) return;
    if (this.zoom === 'fit') {
      const avail = this.scroller.clientWidth - 2 * 28;
      const maxW = Math.max(...this.pages.map((p) => p.w));
      this.scale = clamp(avail / maxW, 0.25, 5);
    } else {
      this.scale = this.zoom;
    }
    this.cb.onZoomChange?.(this.zoom === 'fit' ? 'Fit' : `${Math.round(this.scale * 100)}%`);
  }

  layout() {
    for (const pg of this.pages) {
      pg.el.style.width = `${Math.round(pg.w * this.scale)}px`;
      pg.el.style.height = `${Math.round(pg.h * this.scale)}px`;
      pg.el.style.setProperty('--total-scale-factor', this.scale);
    }
    this.drawChangeBars();
  }

  // bars: [{ page (1-based), x, top, bottom }] in PDF units.
  setChangeBars(bars) {
    this.changeBars = bars;
    this.drawChangeBars();
  }

  drawChangeBars() {
    const bars = this.changeBars || [];
    this.pages.forEach((pg, i) => {
      pg.changes.replaceChildren(...bars.filter((b) => b.page === i + 1).map((b) => {
        const d = document.createElement('div');
        d.className = 'change-bar';
        Object.assign(d.style, {
          left: `${Math.max(2, (b.x - 9) * this.scale)}px`,
          top: `${b.top * this.scale - 2}px`,
          height: `${Math.max(8, (b.bottom - b.top) * this.scale) + 4}px`,
        });
        return d;
      }));
    });
  }

  captureAnchor() {
    const top = this.scroller.scrollTop;
    for (let i = 0; i < this.pages.length; i++) {
      const el = this.pages[i].el;
      if (el.offsetTop + el.offsetHeight + GAP > top) {
        return { i, frac: (top - el.offsetTop) / Math.max(1, el.offsetHeight), left: this.scroller.scrollLeft / Math.max(1, this.scroller.scrollWidth) };
      }
    }
    return null;
  }

  restoreAnchor(a) {
    if (!a || !this.pages.length) return;
    const el = this.pages[Math.min(a.i, this.pages.length - 1)].el;
    this.scroller.scrollTop = el.offsetTop + a.frac * el.offsetHeight;
    this.scroller.scrollLeft = a.left * this.scroller.scrollWidth;
  }

  onResize() {
    if (this.zoom !== 'fit' || !this.pages.length) return;
    const anchor = this.captureAnchor();
    this.computeScale();
    this.layout();
    this.restoreAnchor(anchor);
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.renderVisible(), 120);
  }

  setZoom(z) {
    const anchor = this.captureAnchor();
    this.zoom = z === 'fit' ? 'fit' : clamp(z, 0.25, 5);
    this.computeScale();
    this.layout();
    this.restoreAnchor(anchor);
    this.renderVisible();
  }

  zoomBy(f) { this.setZoom(this.scale * f); }

  queueRender() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.updatePageIndicator();
      clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => this.renderVisible(), 40);
    });
  }

  updatePageIndicator() {
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 3;
    let current = 0;
    for (let i = 0; i < this.pages.length; i++) if (this.pages[i].el.offsetTop <= mid) current = i;
    if (current + 1 !== this.currentPage) {
      this.currentPage = current + 1;
      this.cb.onPageChange?.(this.currentPage, this.pages.length);
    }
  }

  async renderVisible() {
    const { scrollTop, clientHeight } = this.scroller;
    const lo = scrollTop - clientHeight * 0.6;
    const hi = scrollTop + clientHeight * 1.6;
    const dpr = window.devicePixelRatio || 1;
    const key = `${this.loadSeq}:${this.scale.toFixed(4)}:${dpr}`;
    const visible = this.pages.filter((p) => p.el.offsetTop + p.el.offsetHeight >= lo && p.el.offsetTop <= hi && p.key !== key);
    // Pages nearest the viewport centre first.
    const centre = scrollTop + clientHeight / 2;
    visible.sort((a, b) => Math.abs(a.el.offsetTop + a.el.offsetHeight / 2 - centre) - Math.abs(b.el.offsetTop + b.el.offsetHeight / 2 - centre));
    this.updatePageIndicator();
    await Promise.all(visible.map((pg) => this.renderPage(pg, key, dpr)));
  }

  async renderPage(pg, key, dpr) {
    if (!pg.pdfPage) return;
    pg.task?.cancel();
    const viewport = pg.pdfPage.getViewport({ scale: this.scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = pg.pdfPage.render({ canvas, viewport, background: '#ffffff' });
    pg.task = task;
    try {
      await task.promise;
    } catch {
      return; // cancelled by a newer render or document
    }
    if (pg.task !== task) return;
    pg.task = null;
    pg.canvas.replaceWith(canvas);
    pg.canvas = canvas;
    pg.key = key;
    await this.renderText(pg, key);
  }

  async renderText(pg, key) {
    if (pg.textKey === key) return;
    pg.textTask?.cancel();
    const div = document.createElement('div');
    div.className = 'textLayer';
    const layer = new pdfjs.TextLayer({
      textContentSource: pg.pdfPage.streamTextContent(),
      container: div,
      viewport: pg.pdfPage.getViewport({ scale: this.scale }),
    });
    pg.textTask = layer;
    try {
      await layer.render();
    } catch {
      return;
    }
    if (pg.textTask !== layer) return;
    const end = document.createElement('div');
    end.className = 'endOfContent';
    div.append(end);
    pg.text.replaceWith(div);
    Object.assign(pg, { text: div, textDivs: layer.textDivs, textKey: key, hay: null });
    this.cb.onTextLayer?.(this.pages.indexOf(pg));
  }

  // 1-based page and fraction down that page at `frac` of the viewport height.
  readingPoint(frac = 0.3) {
    const y = this.scroller.scrollTop + this.scroller.clientHeight * frac;
    for (let i = 0; i < this.pages.length; i++) {
      const el = this.pages[i].el;
      if (y < el.offsetTop + el.offsetHeight + GAP) {
        return { page: i + 1, frac: clamp((y - el.offsetTop) / el.offsetHeight, 0, 1) };
      }
    }
    return null;
  }

  // Put PDF point y (in PDF units) of `page` at `frac` of the viewport height, instantly.
  scrollToY(page, y, frac = 0.3) {
    const pg = this.pages[page - 1];
    if (pg) this.scroller.scrollTop = pg.el.offsetTop + y * this.scale - this.scroller.clientHeight * frac;
  }

  scrollToPoint(page, x, y, h) {
    const pg = this.pages[page - 1];
    if (!pg) return;
    const top = pg.el.offsetTop + y * this.scale - this.scroller.clientHeight * 0.3;
    this.scroller.scrollTo({ top, behavior: 'smooth' });
    const mark = document.createElement('div');
    mark.className = 'sync-mark';
    mark.style.top = `${y * this.scale - 3}px`;
    mark.style.height = `${Math.max(h, 10) * this.scale + 6}px`;
    pg.el.appendChild(mark);
    setTimeout(() => mark.remove(), 1600);
  }

  clear() {
    this.loadSeq++;
    for (const pg of this.pages) { pg.task?.cancel(); pg.textTask?.cancel(); pg.el.remove(); }
    this.pages = [];
    this.doc?.destroy();
    this.doc = null;
  }
}

// Port of pdf.js viewer's selection handling for Chrome: while selecting, the
// .endOfContent block follows the selection end so dragging through gaps
// (e.g. between the two columns of a paper) doesn't jump to the end of the page.
let selectionFixInstalled = false;
function installSelectionFix() {
  if (selectionFixInstalled) return;
  selectionFixInstalled = true;
  let pointerDown = false;
  let prevRange = null;
  const layers = () => document.querySelectorAll('.pdf-page > .textLayer');
  const reset = (layer) => {
    const end = layer.querySelector('.endOfContent');
    if (end) {
      layer.append(end);
      end.style.width = end.style.height = end.style.userSelect = '';
    }
    layer.classList.remove('selecting');
  };
  document.addEventListener('pointerdown', () => { pointerDown = true; });
  document.addEventListener('pointerup', () => { pointerDown = false; layers().forEach(reset); });
  window.addEventListener('blur', () => { pointerDown = false; layers().forEach(reset); });
  document.addEventListener('keyup', () => { if (!pointerDown) layers().forEach(reset); });
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection.rangeCount) { layers().forEach(reset); return; }
    const range = selection.getRangeAt(0);
    let active = false;
    for (const layer of layers()) {
      if (range.intersectsNode(layer)) { layer.classList.add('selecting'); active = true; } else reset(layer);
    }
    if (!active) { prevRange = null; return; }
    const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0
      || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
    let anchor = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0) {
      do {
        while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor?.previousSibling;
      } while (anchor && !anchor.childNodes.length);
    }
    const layer = anchor?.parentElement?.closest('.textLayer');
    const end = layer?.querySelector('.endOfContent');
    if (end && anchor.parentElement) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      end.style.userSelect = 'text';
      anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    prevRange = range.cloneRange();
  });
}
