// Markdown main files: pandoc turns them into LaTeX, which Tectonic compiles like any other main file.
// Before pandoc runs, a \underleafsrc{N} line goes in front of each top-level block (N = the block's
// line in the .md). It typesets as nothing, but lets positions in the generated LaTeX (SyncTeX, error
// lines) be traced back to the Markdown. The .md on disk is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const HEADER = '\\providecommand{\\underleafsrc}[1]{}\n';
// Lowest-priority metadata: the document's own YAML header overrides it.
const DEFAULTS = 'geometry: margin=1in\n';
const MARK = /^\\underleafsrc\{(\d+)\}\s*$/;
const LIST_ITEM = /^([-+*]|\(?(\d+|#|@\w*|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)])(\s|$)/;

export const isMarkdown = (p) => /\.(md|markdown)$/i.test(p);

// A marker may go before a block that starts in column 0 after a blank line, unless the line continues
// the block before it (the next item of a list, more of a quote), or is a caption, a definition, a
// title block or a rule/front matter. A missing marker only makes the map coarser; a misplaced one
// could split a list, so when in doubt, leave it out.
function canMark(line, prev) {
  if (!/^\S/.test(line) || /^(:|Table:|%|-{3,}|\.{3,})/.test(line)) return false;
  if (LIST_ITEM.test(line) && prev != null && (LIST_ITEM.test(prev) || /^\s/.test(prev))) return false;
  if (line.startsWith('>') && prev?.startsWith('>')) return false;
  return true;
}

// The Markdown with markers added, and the original line of each line of it (for pandoc's messages).
export function markSource(md) {
  const lines = md.split('\n');
  const out = [];
  const orig = [];
  const push = (l, n) => { out.push(l); orig.push(n); };
  let fence = null; // the ``` or ~~~ that opened a code block
  let until = null; // the line that closes a raw environment or YAML block
  let prevBlank = true;
  let prev = null; // the last non-blank line
  lines.forEach((line, i) => {
    const n = i + 1;
    const blank = !line.trim();
    if (fence) {
      const m = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (until) {
      if (until.test(line)) until = null;
    } else {
      if (!blank && prevBlank && canMark(line, prev)) { push(`\\underleafsrc{${n}}`, n); push('', n); }
      const f = line.match(/^\s*(`{3,}(?=[^`]*$)|~{3,})/);
      const env = line.match(/^\\begin\{([^}]+)\}/);
      if (f) fence = f[1];
      else if (env && !line.includes(`\\end{${env[1]}}`)) until = new RegExp(`\\\\end\\{${env[1].replace(/\W/g, '\\$&')}\\}`);
      else if (/^-{3,}\s*$/.test(line) && prevBlank && lines[i + 1]?.trim()) until = /^(-{3,}|\.{3,})\s*$/;
    }
    push(line, n);
    if (!blank) prev = line;
    prevBlank = blank;
  });
  return { text: out.join('\n'), origLine: (k) => orig[Math.max(0, k - 1)] ?? lines.length };
}

// Line map between the generated LaTeX and the Markdown, from the markers pandoc passed through.
// Inside a block, lines are matched one to one (pandoc runs with --wrap=preserve), clamped to the block.
export function lineMap(tex, mdLines = Infinity) {
  const lines = tex.split('\n');
  const marks = [];
  lines.forEach((l, i) => { const m = MARK.exec(l); if (m) marks.push({ line: i + 1, md: +m[1] }); });
  const blocks = [];
  marks.forEach((m, k) => {
    const next = marks[k + 1];
    const stop = next ? next.line : lines.length + 1;
    let start = m.line + 1;
    while (start < stop && !lines[start - 1].trim()) start++;
    if (start >= stop) return; // the block produced no LaTeX (a link definition, say)
    let end = stop - 1;
    while (end > start && !lines[end - 1].trim()) end--;
    blocks.push({ tex: start, end, md: m.md, mdEnd: next ? Math.max(m.md, next.md - 2) : Infinity });
  });
  return {
    toMd(t) {
      let b = null;
      for (const x of blocks) { if (x.tex > t) break; b = x; }
      if (!b) return 1;
      return Math.max(1, Math.min(b.md + (t - b.tex), b.mdEnd, mdLines));
    },
    toTex(line) {
      let b = blocks[0];
      for (const x of blocks) { if (x.md > line) break; b = x; }
      if (!b) return 1;
      return Math.min(b.tex + Math.max(0, line - b.md), b.end);
    },
  };
}

// Runs pandoc on `src` (absolute) and writes the LaTeX to `out`. Resolves to
// { ok, map, errors, warnings, output } with messages attributed to `file` (the project-relative .md).
export function buildMarkdown(pandoc, { src, file, out, buildDir }) {
  return new Promise((resolve) => {
    const fail = (message, output = '') => resolve({ ok: false, map: null, errors: [{ severity: 'error', file, message }], warnings: [], output });
    const header = path.join(buildDir, 'markdown-header.tex');
    const defaults = path.join(buildDir, 'markdown-defaults.yaml');
    let md;
    try {
      md = fs.readFileSync(src, 'utf8');
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(header, HEADER);
      fs.writeFileSync(defaults, DEFAULTS);
    } catch (err) { return fail(err.message); }
    const marked = markSource(md);
    const args = ['-f', 'markdown', '-t', 'latex', '-s', '--wrap=preserve', '--citeproc',
      `--metadata-file=${defaults}`, '-H', header, '-o', out];
    // Run from the .md's folder, so a `bibliography:` in its YAML is found next to it.
    const child = spawn(pandoc, args, { cwd: path.dirname(src) });
    let stderr = '';
    child.on('error', (err) => { stderr += `could not run pandoc: ${err.message}\n`; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {});
    child.stdin.end(marked.text);
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      // pandoc numbers lines of its input, which has the markers in it: give them back as .md lines.
      // (YAML errors count from the start of the YAML block instead, so those are left as they are.)
      let first = null;
      const fix = (s) => (/YAML/.test(s) ? s
        : s.replace(/\bline (\d+)/g, (_, k) => { const n = marked.origLine(+k); first ??= n; return `line ${n}`; }));
      const warnings = [];
      const rest = [];
      for (const chunk of stderr.split(/\n(?=\[)/)) {
        const w = chunk.match(/^\[WARNING\] ([\s\S]*)/);
        if (w) {
          first = null;
          const message = fix(w[1].replace(/\s+/g, ' ').trim());
          warnings.push({ severity: 'warning', file: first ? file : null, line: first, message });
        } else if (chunk.trim()) rest.push(chunk.trim());
      }
      if (code !== 0) {
        first = null;
        const message = fix(rest.join('\n')) || `pandoc exited with code ${code}`;
        return resolve({ ok: false, map: null, errors: [{ severity: 'error', file, line: first, message }], warnings, output: stderr });
      }
      let tex = '';
      try { tex = fs.readFileSync(out, 'utf8'); } catch (err) { return fail(err.message, stderr); }
      resolve({ ok: true, map: lineMap(tex, md.split('\n').length), errors: [], warnings, output: stderr });
    });
  });
}
