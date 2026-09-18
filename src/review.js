// Readable review of edits made outside the editor (Claude): each change becomes a card with a
// plain-language summary, where it is, and Before / After text with the edited words marked.
import { Chunk } from '@codemirror/merge';
import { Text } from '@codemirror/state';

// Line-based change blocks between two texts, with word-level edits inside each block.
export function computeChanges(base, current) {
  const A = Text.of(base.split('\n'));
  const B = Text.of(current.split('\n'));
  return Chunk.build(A, B).map((c) => {
    const lineB = B.lineAt(Math.min(c.fromB, B.length)).number;
    return {
      fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB,
      lineA: A.lineAt(Math.min(c.fromA, A.length)).number,
      lineB,
      lineEndB: c.toB > c.fromB ? B.lineAt(c.endB).number : lineB,
      before: c.toA > c.fromA ? base.slice(c.fromA, c.endA) : '',
      after: c.toB > c.fromB ? current.slice(c.fromB, c.endB) : '',
      changes: c.changes.map((x) => ({ fromA: x.fromA, toA: x.toA, fromB: x.fromB, toB: x.toB })),
    };
  });
}

// Accept one change: the "before" text takes that block from the current text.
export const keepChange = (base, current, h) => base.slice(0, h.fromA) + current.slice(h.fromB, h.toB) + base.slice(h.toA);

// Revert one change: the current text takes that block back from the "before" text.
export const undoChange = (base, current, h) => current.slice(0, h.fromB) + base.slice(h.fromA, h.toA) + current.slice(h.toB);

const q = (s, max = 80) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
};

export function describe(h) {
  const block = (text, verb) => {
    const lines = text.split('\n').filter((l) => l.trim());
    return lines.length > 1 ? `${verb} ${lines.length} lines, starting ${q(lines[0], 60)}` : `${verb} ${q(text)}`;
  };
  if (!h.before.trim()) return { kind: 'added', label: 'Added', text: block(h.after, 'Added') };
  if (!h.after.trim()) return { kind: 'removed', label: 'Removed', text: block(h.before, 'Removed') };
  const parts = h.changes
    .map((c) => ({ del: h.before.slice(c.fromA, c.toA).trim(), ins: h.after.slice(c.fromB, c.toB).trim() }))
    .filter((p) => p.del || p.ins);
  if (parts.length === 1) {
    const { del, ins } = parts[0];
    if (del && ins) return { kind: 'edited', label: 'Edited', text: `Replaced ${q(del)} with ${q(ins)}` };
    if (ins) return { kind: 'edited', label: 'Edited', text: `Inserted ${q(ins)}` };
    return { kind: 'edited', label: 'Edited', text: `Deleted ${q(del)}` };
  }
  const said = parts.slice(0, 2).map(({ del, ins }) => (del && ins ? `replaced ${q(del, 36)} with ${q(ins, 36)}` : ins ? `added ${q(ins, 48)}` : `deleted ${q(del, 40)}`));
  return { kind: 'edited', label: 'Edited', text: `${parts.length} edits: ${said.join('; ')}${parts.length > 2 ? `; and ${parts.length - 2} more` : ''}` };
}

// For long passages, the stretches around the edits (whole sentences where cheap), as
// [{ a: {from, to}, b: {from, to} }] windows into before/after. Null means show everything.
export function excerpts(h, context = 120) {
  const changes = h.changes.filter((c) => c.toA > c.fromA || c.toB > c.fromB);
  if (!h.before || !h.after || h.before.length + h.after.length < 900 || !changes.length) return null;
  const groups = [];
  for (const c of changes) {
    const g = groups[groups.length - 1];
    if (g && c.fromA - g.toA < context * 2 && c.fromB - g.toB < context * 2) {
      g.toA = Math.max(g.toA, c.toA);
      g.toB = Math.max(g.toB, c.toB);
    } else {
      groups.push({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB });
    }
  }
  const windows = [];
  for (const g of groups) {
    const w = { a: widen(h.before, g.fromA - context, g.toA + context), b: widen(h.after, g.fromB - context, g.toB + context) };
    const prev = windows[windows.length - 1];
    // Sentence widening can make neighbours overlap: merge them so no text shows twice.
    if (prev && (w.a.from <= prev.a.to || w.b.from <= prev.b.to)) {
      prev.a.to = Math.max(prev.a.to, w.a.to);
      prev.b.to = Math.max(prev.b.to, w.b.to);
    } else {
      windows.push(w);
    }
  }
  return windows;
}

function widen(text, from, to) {
  from = Math.max(0, from);
  to = Math.min(text.length, to);
  const sentenceStart = text.lastIndexOf('. ', from);
  if (sentenceStart !== -1 && from - sentenceStart < 90) from = sentenceStart + 2;
  else if (from > 0) from = text.lastIndexOf(' ', from) + 1;
  const sentenceEnd = text.indexOf('. ', to);
  if (sentenceEnd !== -1 && sentenceEnd - to < 90) to = sentenceEnd + 1;
  else if (to < text.length) to = text.indexOf(' ', to) === -1 ? text.length : text.indexOf(' ', to);
  return { from, to };
}

// Nearest heading above a position, e.g. "Introduction" or "Abstract".
export function sectionAt(text, pos) {
  const re = /\\(?:sub)*section\*?\{([^}]*)\}|\\begin\{abstract\}|\\title\{|\\bibliography\{/g;
  const head = text.slice(0, pos);
  let last = null;
  for (let m; (m = re.exec(head));) last = m;
  if (!last) return '';
  if (last[1] !== undefined) return last[1];
  return last[0].startsWith('\\begin') ? 'Abstract' : last[0].startsWith('\\title') ? 'Title' : 'Bibliography';
}

// Text with some ranges wrapped in <mark class=cls>; LaTeX commands and braces are dimmed so prose reads first.
export function markedText(text, ranges, cls) {
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
    let from = Math.max(pos, Math.min(r.from, text.length));
    let to = Math.min(r.to, text.length);
    // Leading/trailing blank space and newlines stay unmarked, so edits never paint empty lines.
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (from > pos) frag.append(latex(text.slice(pos, from)));
    if (to > from) {
      // One mark per line, so blank lines inside a multi-line edit aren't painted.
      for (const piece of text.slice(from, to).split(/(\n\s*)/)) {
        if (!piece.trim()) { frag.append(piece); continue; }
        const m = document.createElement('mark');
        m.className = cls;
        m.append(latex(piece));
        frag.append(m);
      }
    }
    pos = Math.max(pos, to);
  }
  if (pos < text.length) frag.append(latex(text.slice(pos)));
  return frag;
}

function latex(s) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of s.matchAll(/%[^\n]*|\\[a-zA-Z@]+\*?|[{}]/g)) {
    if (m.index > last) frag.append(s.slice(last, m.index));
    const span = document.createElement('span');
    span.className = m[0][0] === '%' ? 'tx-comment' : 'tx-cmd';
    span.textContent = m[0];
    frag.append(span);
    last = m.index + m[0].length;
  }
  if (last < s.length) frag.append(s.slice(last));
  return frag;
}
