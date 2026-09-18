// Text selection and highlights on the PDF. Highlights are anchored by their text
// (not coordinates), so they survive zoom and recompiles and vanish once edited away.

const squash = (s) => s.replace(/\s+/g, '');

// The current selection inside the PDF, split per page, or null.
export function readPdfSelection(view) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const parts = [];
  view.pages.forEach((pg, i) => {
    if (!pg.textKey || !range.intersectsNode(pg.text)) return;
    const r = range.cloneRange();
    if (!pg.text.contains(range.startContainer)) r.setStart(pg.text, 0);
    if (!pg.text.contains(range.endContainer)) r.setEnd(pg.text, pg.text.childNodes.length);
    const text = r.toString().replace(/\s+/g, ' ').trim();
    const rects = [...r.getClientRects()].filter((x) => x.width > 1 && x.height > 1);
    if (!text || !rects.length) return;
    const box = pg.el.getBoundingClientRect();
    parts.push({ page: i, text, rects, yHint: (rects[0].top - box.top) / box.height, box });
  });
  if (!parts.length) return null;
  const s = view.scale;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const r0 = first.rects[0];
  const r1 = last.rects[last.rects.length - 1];
  return {
    text: parts.map((p) => p.text).join(' '),
    parts,
    start: { page: first.page + 1, x: (r0.left - first.box.left) / s + 1, y: (r0.top + r0.height * 0.75 - first.box.top) / s },
    end: { page: last.page + 1, x: (r1.right - last.box.left) / s - 1, y: (r1.top + r1.height * 0.75 - last.box.top) / s },
    anchor: { left: r0.left, top: Math.min(...first.rects.map((x) => x.top)), bottom: Math.max(...last.rects.map((x) => x.bottom)) },
  };
}

export class PdfMarks {
  constructor(view, { onChange } = {}) {
    this.view = view;
    this.items = []; // { id, page, text, yHint, src }
    this.temp = [];
    this.onChange = onChange;
    this.seq = 1;
  }

  load(items) {
    this.items = (items || []).map((it) => ({ ...it, id: this.seq++ }));
    this.drawAll();
  }

  add(parts, src) {
    for (const p of parts) this.items.push({ id: this.seq++, page: p.page, text: p.text, yHint: p.yHint, src });
    this.drawAll();
    this.onChange?.();
  }

  remove(id) {
    this.items = this.items.filter((it) => it.id !== id);
    this.drawAll();
    this.onChange?.();
  }

  clear() {
    this.items = [];
    this.drawAll();
    this.onChange?.();
  }

  setTemp(parts) {
    this.temp = parts.map((p) => ({ id: 0, page: p.page, text: p.text, yHint: p.yHint, temp: true }));
    this.drawAll();
  }

  clearTemp() {
    if (!this.temp.length) return;
    this.temp = [];
    this.drawAll();
  }

  drawAll() {
    this.view.pages.forEach((_, i) => this.drawPage(i));
  }

  // Re-anchor and draw the highlights of one page (after its text layer renders).
  drawPage(index) {
    const pg = this.view.pages[index];
    if (!pg?.textKey) return;
    const out = [];
    let dropped = false;
    for (const it of [...this.items, ...this.temp]) {
      if (it.page !== index) continue;
      const rects = this.locate(index, it.text, it.yHint);
      if (!rects) {
        // The passage is gone from this version of the PDF (edited away): forget it.
        if (!it.temp) { this.items = this.items.filter((x) => x !== it); dropped = true; }
        continue;
      }
      for (const r of rects) {
        const d = document.createElement('div');
        d.className = it.temp ? 'hl temp' : 'hl';
        d.dataset.id = it.id;
        Object.assign(d.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        out.push(d);
      }
    }
    pg.marks.replaceChildren(...out);
    if (dropped) this.onChange?.();
  }

  // Rects (page-relative CSS px) of `text` on page `index`, preferring the occurrence nearest yHint.
  locate(index, text, yHint = 0) {
    const pg = this.view.pages[index];
    const needle = squash(text);
    if (needle.length < 2 || !pg.textDivs.length) return null;
    if (!pg.hay) {
      let hay = '';
      const map = [];
      pg.textDivs.forEach((div, di) => {
        const t = div.textContent;
        for (let k = 0; k < t.length; k++) {
          if (/\s/.test(t[k])) continue;
          hay += t[k];
          map.push([di, k]);
        }
      });
      pg.hay = { hay, map };
    }
    const { hay, map } = pg.hay;
    const box = pg.el.getBoundingClientRect();
    let best = null;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
      const [d1, k1] = map[at];
      const [d2, k2] = map[at + needle.length - 1];
      const range = document.createRange();
      try {
        range.setStart(pg.textDivs[d1].firstChild, k1);
        range.setEnd(pg.textDivs[d2].firstChild, k2 + 1);
      } catch {
        continue;
      }
      const rects = mergeRects([...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5), box);
      if (!rects.length) continue;
      const dist = Math.abs(rects[0].top / box.height - yHint);
      if (!best || dist < best.dist) best = { rects, dist };
    }
    return best?.rects ?? null;
  }

  // Highlight id under a viewport point, or 0.
  hitTest(x, y) {
    for (const pg of this.view.pages) {
      for (const d of pg.marks.children) {
        if (d.classList.contains('temp')) continue;
        const r = d.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { id: +d.dataset.id, rect: r };
      }
    }
    return null;
  }

  get count() { return this.items.length; }

  serialize() {
    return this.items.map(({ page, text, yHint, src }) => ({ page, text, yHint, src }));
  }
}

// Merge the per-span rects of a range into one rect per visual line, relative to `box`.
function mergeRects(rects, box) {
  const lines = [];
  for (const r of rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
    const rel = { left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top };
    const line = lines.find((l) => Math.abs(l.top - rel.top) < 3 && rel.left <= l.right + 6 && rel.right >= l.left - 6);
    if (line) {
      line.left = Math.min(line.left, rel.left);
      line.right = Math.max(line.right, rel.right);
      line.top = Math.min(line.top, rel.top);
      line.bottom = Math.max(line.bottom, rel.bottom);
    } else {
      lines.push(rel);
    }
  }
  return lines.map((l) => ({ left: l.left - 1, top: l.top - 1, width: l.right - l.left + 2, height: l.bottom - l.top + 2 }));
}
