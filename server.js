#!/usr/bin/env node
// Underleaf — a local Overleaf: CodeMirror editor, Tectonic/TeXpresso preview, Claude Code terminal.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { watch } from 'chokidar';
import pty from 'node-pty';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(APP_DIR, 'public');
const DATA_DIR = path.join(os.homedir(), '.local/share/underleaf');

// ---------------------------------------------------------------- args & project

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--port'].includes(argv[i - 1])));

const TEMPLATE = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath, amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Start writing here. Select some text and press \texttt{Ctrl+K} to ask Claude about it.

\begin{equation}
  e^{i\pi} + 1 = 0
\end{equation}

\end{document}
`;

// `underleaf ~/My Papers/thesis` without quotes arrives as several arguments, and a path copied
// across a line break carries a newline: try those spellings before giving up.
function pickTarget(parts) {
  if (!parts.length) return undefined;
  const spellings = [parts[0], parts.join(' ')].flatMap((p) => [p, p.replace(/\s*\n\s*/g, ' ')]);
  return spellings.find((p) => fs.existsSync(path.resolve(p))) ?? parts.join(' ').replace(/\s*\n\s*/g, ' ');
}

function resolveProject(target) {
  if (!target && [os.homedir(), '/'].includes(process.cwd())) {
    console.error('underleaf: run it inside a LaTeX project folder, or pass one, e.g.  underleaf ~/papers/thesis');
    process.exit(1);
  }
  let abs = path.resolve(target || process.cwd());
  let main = null;
  const fail = (what) => {
    console.error(`underleaf: ${what}: ${abs}\nIf the path contains spaces, put it in quotes: underleaf "${abs}"`);
    process.exit(1);
  };
  if (abs.endsWith('.tex')) {
    if (!fs.existsSync(abs)) {
      if (!fs.existsSync(path.dirname(abs))) fail('no such folder for the new file');
      fs.writeFileSync(abs, TEMPLATE);
    }
    main = path.basename(abs);
    abs = path.dirname(abs);
  } else if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    fail('no such folder');
  }
  return { root: fs.realpathSync(abs), main };
}

const project = resolveProject(pickTarget(positional));
const ROOT = project.root;
const BUILD = path.join(ROOT, '.underleaf');
fs.mkdirSync(BUILD, { recursive: true });
try { fs.writeFileSync(path.join(BUILD, '.gitignore'), '*\n', { flag: 'wx' }); } catch {}
const STATE_FILE = path.join(BUILD, 'state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
const state = loadState();
const saveState = () => fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});

// ---------------------------------------------------------------- binaries

function which(name, extra = []) {
  const dirs = [...(process.env.PATH || '').split(':'), path.join(os.homedir(), '.local/bin'), ...extra];
  for (const d of dirs) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}
const TECTONIC = process.env.UNDERLEAF_TECTONIC || which('tectonic', [path.join(os.homedir(), '.cargo/bin')]);
const CLAUDE = process.env.UNDERLEAF_CLAUDE || which('claude', [path.join(os.homedir(), '.claude/local')]);
const TEXPRESSO = process.env.UNDERLEAF_TEXPRESSO || which('texpresso', [path.join(DATA_DIR, 'deps/texpresso/build')]);
const XPROP = process.env.DISPLAY ? which('xprop') : null;

// ---------------------------------------------------------------- files

const TEXT_EXT = new Set(['.tex', '.ltx', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.lbx', '.cfg', '.def', '.clo',
  '.dtx', '.ins', '.tikz', '.pgf', '.txt', '.md', '.csv', '.dat', '.json', '.yaml', '.yml', '.py', '.m', '.gitignore']);
const BUILD_EXT = new Set([...TEXT_EXT, '.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.otf', '.ttf']);
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.underleaf']);

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
function inRoot(p) {
  const abs = path.resolve(ROOT, p);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('path escapes project');
  return abs;
}
const isHiddenRel = (r) => r.split('/').some((s) => s.startsWith('.') || SKIP_DIRS.has(s));
const isText = (r) => TEXT_EXT.has(path.extname(r).toLowerCase()) || path.basename(r) === 'Makefile';

async function listFiles() {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 8 || out.length > 3000) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs, depth + 1);
      else if (e.isFile()) out.push(rel(abs));
    }
  }
  await walk(ROOT, 0);
  return out.sort((a, b) => a.localeCompare(b));
}

function pickMain(files) {
  if (project.main && files.includes(project.main)) return project.main;
  if (state.main && files.includes(state.main)) return state.main;
  const tex = files.filter((f) => f.endsWith('.tex'));
  if (tex.includes('main.tex')) return 'main.tex';
  const withClass = tex
    .filter((f) => { try { return /\\documentclass/.test(fs.readFileSync(inRoot(f), 'utf8')); } catch { return false; } })
    .sort((a, b) => a.split('/').length - b.split('/').length);
  return withClass[0] || tex[0] || null;
}

// Content we believe is on disk, plus our own recent writes, so watcher echoes are ignored.
const lastKnown = new Map();
const recentWrites = new Map();
function rememberWrite(r, content) {
  const list = recentWrites.get(r) || [];
  list.push(content);
  if (list.length > 8) list.shift();
  recentWrites.set(r, list);
}

let files = await listFiles();
let MAIN = pickMain(files);
if (!MAIN) {
  fs.writeFileSync(path.join(ROOT, 'main.tex'), TEMPLATE);
  files = await listFiles();
  MAIN = 'main.tex';
}

// Remember every text file's contents, so an outside edit (e.g. Claude) arrives with its "before" for review.
(async () => {
  for (const f of files) {
    if (!isText(f) || lastKnown.has(f)) continue;
    try {
      const abs = inRoot(f);
      if ((await fsp.stat(abs)).size <= 2_000_000) lastKnown.set(f, await fsp.readFile(abs, 'utf8'));
    } catch {}
  }
})();

// ---------------------------------------------------------------- websocket plumbing

const clients = new Set();
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

// ---------------------------------------------------------------- compile (tectonic)

const compile = { running: false, pending: false, timer: null, version: 0, last: null, child: null };
const outBase = () => path.join(BUILD, path.basename(MAIN, path.extname(MAIN)));
const pdfPath = () => outBase() + '.pdf';

function scheduleCompile(delay = 150) {
  clearTimeout(compile.timer);
  compile.timer = setTimeout(runCompile, delay);
}

function runCompile() {
  if (!MAIN) return;
  if (compile.running) { compile.pending = true; return; }
  if (!TECTONIC) {
    compile.last = { ok: false, ms: 0, errors: [{ severity: 'error', message: 'tectonic was not found on PATH. Install it from https://tectonic-typesetting.github.io' }], warnings: [] };
    broadcast({ type: 'compile-done', ...compile.last, version: compile.version });
    return;
  }
  compile.running = true;
  compile.pending = false;
  broadcast({ type: 'compile-start' });
  const t0 = Date.now();
  let before = 0;
  try { before = fs.statSync(pdfPath()).mtimeMs; } catch {}
  const args = ['-X', 'compile', '--keep-intermediates', '--keep-logs', '--synctex', '-Z', 'continue-on-errors', '--outdir', BUILD, MAIN];
  const child = spawn(TECTONIC, args, { cwd: ROOT, env: process.env });
  compile.child = child;
  child.on('error', (err) => { output += `error: could not run tectonic: ${err.message}\n`; });
  let output = '';
  const onData = (d) => {
    const s = d.toString();
    output += s;
    for (const line of s.split('\n')) {
      const m = line.match(/^note: downloading (.+)$/);
      if (m) broadcast({ type: 'compile-note', text: `Downloading ${m[1].trim()}` });
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.on('close', (code) => {
    clearTimeout(killer);
    compile.child = null;
    const ms = Date.now() - t0;
    let after = 0;
    try { after = fs.statSync(pdfPath()).mtimeMs; } catch {}
    const newPdf = after > before;
    if (newPdf) { compile.version++; synctexCache = null; }
    const errors = parseTectonicErrors(output);
    if (code !== 0 && errors.length === 0) {
      errors.push({ severity: 'error', message: output.trim().split('\n').filter((l) => !l.startsWith('note:')).slice(-6).join('\n') || `tectonic exited with code ${code}` });
    }
    const warnings = parseLogWarnings();
    compile.last = { ok: code === 0 && errors.length === 0, ms, errors, warnings, rawOutput: output.slice(-20000) };
    writeErrorSummary(errors, warnings);
    broadcast({ type: 'compile-done', ...compile.last, version: compile.version, newPdf });
    compile.running = false;
    if (compile.pending) scheduleCompile(0);
  });
}

function projectFileFor(name) {
  if (!name) return null;
  const candidates = [name, path.join(path.dirname(MAIN), name)];
  for (const c of candidates) {
    try {
      const abs = inRoot(c);
      if (fs.existsSync(abs)) return rel(abs);
    } catch {}
  }
  return null;
}

function parseTectonicErrors(output) {
  const seen = new Set();
  const list = [];
  for (const line of output.split('\n')) {
    let m = line.match(/^(error|warning): (.+?):(\d+): (.*)$/);
    if (m) {
      const key = m.slice(1).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      if (m[1] === 'warning') continue; // warnings come from the log, with better text
      list.push({ severity: 'error', file: projectFileFor(m[2]), rawFile: m[2], line: +m[3], message: m[4].replace(/^! /, '') });
      continue;
    }
    m = line.match(/^error: (.*)$/);
    if (m && !/halted on|something bad happened|errors were issued/.test(m[1]) && !seen.has(m[1])) {
      seen.add(m[1]);
      list.push({ severity: 'error', message: m[1] });
    }
  }
  return list;
}

// Light LaTeX log parser: tracks the "(file" / ")" stack to attribute warnings to source files.
function parseLogWarnings() {
  let log;
  try { log = fs.readFileSync(outBase() + '.log', 'utf8'); } catch { return []; }
  const lines = log.split('\n');
  const stack = [];
  const out = [];
  const seen = new Set();
  const fileRe = /\((\.?\.?\/?[^\s()]+\.(?:tex|ltx|sty|cls|bbl|aux|toc|clo|cfg|def|fd|out))/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // update the file stack
    let j = 0;
    while (j < line.length) {
      const ch = line[j];
      if (ch === '(') {
        fileRe.lastIndex = j;
        const m = fileRe.exec(line);
        if (m && m.index === j) { stack.push(m[1]); j += m[0].length; continue; }
        stack.push(null);
      } else if (ch === ')') {
        stack.pop();
      }
      j++;
    }
    const w = line.match(/^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/);
    if (!w) continue;
    let msg = w[3];
    let k = i + 1;
    while (k < lines.length && lines[k].trim() !== '' && /^\(\S+\)\s/.test(lines[k])) { msg += ' ' + lines[k].replace(/^\(\S+\)\s+/, ''); k++; }
    const lineNo = msg.match(/on input line (\d+)/);
    const current = [...stack].reverse().find((f) => f && /\.(tex|ltx)$/.test(f));
    const file = projectFileFor(current ? current.replace(/^\.\//, '') : MAIN) || MAIN;
    const text = (w[1] ? `${w[1]}: ` : '') + msg.replace(/\s+/g, ' ').trim();
    const key = `${file}|${lineNo?.[1]}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ severity: 'warning', file: lineNo ? file : null, line: lineNo ? +lineNo[1] : null, message: text });
    if (out.length > 200) break;
  }
  return out;
}

function writeErrorSummary(errors, warnings) {
  const fmt = (e) => `${e.file ?? e.rawFile ?? ''}${e.line ? ':' + e.line : ''}${e.file || e.rawFile ? ': ' : ''}${e.message}`;
  const text = [
    `# Underleaf build of ${MAIN} at ${new Date().toISOString()}`,
    `# ${errors.length} error(s), ${warnings.length} warning(s). Full log: .underleaf/${path.basename(outBase())}.log`,
    '', '## Errors', ...errors.map(fmt), '', '## Warnings', ...warnings.map(fmt), '',
  ].join('\n');
  fs.writeFile(path.join(BUILD, 'errors.txt'), text, () => {});
}

// ---------------------------------------------------------------- synctex

let synctexCache = null;
const SP_PER_BP = 65781.76;

function loadSynctex() {
  if (synctexCache) return synctexCache;
  const buf = fs.readFileSync(outBase() + '.synctex.gz');
  const text = zlib.gunzipSync(buf).toString('utf8');
  const inputs = new Map();
  const pages = [];
  const lineBoxes = [];
  let unit = 1, cur = null, lines = null, stack = [], content = false;
  const recRe = /^([[(hvxkg$r])(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;
  for (const L of text.split('\n')) {
    if (L.startsWith('Input:')) {
      const m = L.match(/^Input:(\d+):(.*)$/);
      if (m && m[2]) inputs.set(+m[1], path.resolve(ROOT, m[2]));
      continue;
    }
    if (!content) {
      if (L.startsWith('Unit:')) unit = +L.slice(5) || 1;
      if (L === 'Content:') content = true;
      continue;
    }
    const c = L[0];
    if (c === '{') {
      const n = parseInt(L.slice(1), 10);
      cur = pages[n] = [];
      lines = lineBoxes[n] = [];
      stack = [];
      continue;
    }
    if (c === '}') { cur = null; continue; }
    if (!cur) continue;
    if (c === ')' || c === ']') {
      const top = stack.pop();
      const parent = stack[stack.length - 1];
      if (c === ')' && top?.rec && !top.hasVbox && (!parent || parent.t === '[')) lines.push(top.rec);
      continue;
    }
    const m = recRe.exec(L);
    if (!m) continue;
    const k = (v) => (v === undefined ? 0 : (+v * unit) / SP_PER_BP);
    const isBox = c === '[' || c === '(' || c === 'h' || c === 'v' || c === 'r';
    const rec = { t: c, tag: +m[2], line: +m[3], x: k(m[4]), y: k(m[5]), w: isBox || c === 'k' ? k(m[6]) : 0, h: isBox ? k(m[7]) : 0, d: isBox ? k(m[8]) : 0 };
    cur.push(rec);
    if (c === '(') stack.push({ t: '(', rec, hasVbox: false });
    if (c === '[') {
      for (const b of stack) if (b.t === '(') b.hasVbox = true;
      stack.push({ t: '[' });
    }
  }
  synctexCache = { inputs, pages, lineBoxes };
  return synctexCache;
}

function tagInProject(sx, tag) {
  const abs = sx.inputs.get(tag);
  return abs && (abs === ROOT || abs.startsWith(ROOT + path.sep)) ? abs : null;
}

function syncBackward(page, px, py) {
  const sx = loadSynctex();
  const recs = (sx.pages[page] || []).filter((r) => r.line > 0 && tagInProject(sx, r.tag));
  if (!recs.length) return null;
  let box = null, boxArea = Infinity;
  for (const r of recs) {
    if (r.t !== '(' && r.t !== 'h') continue;
    if (px >= r.x - 1 && px <= r.x + r.w + 1 && py >= r.y - r.h - 2 && py <= r.y + r.d + 2) {
      const a = Math.max(r.w, 1) * Math.max(r.h + r.d, 1);
      if (a < boxArea) { boxArea = a; box = r; }
    }
  }
  let best = null, bestD = Infinity;
  for (const r of recs) {
    if (!'xkg$'.includes(r.t)) continue;
    if (box && (r.y < box.y - box.h - 2 || r.y > box.y + box.d + 2)) continue;
    const d = Math.abs(r.x - px) + Math.abs(r.y - py) * 3;
    if (d < bestD) { bestD = d; best = r; }
  }
  if (!best && !box) {
    for (const r of recs) {
      const d = Math.abs(r.x - px) + Math.abs(r.y - py) * 3;
      if (d < bestD) { bestD = d; best = r; }
    }
  }
  const hit = best || box;
  return { path: rel(tagInProject(sx, hit.tag)), line: hit.line };
}

// Linked scrolling, PDF -> source: the text line `frac` of the way through the page's lines
// in reading order (follows both columns of a two-column paper in turn).
function linkFromPdf(page, frac) {
  const sx = loadSynctex();
  const boxes = (sx.lineBoxes[page] || []).filter((r) => r.line > 0 && r.w > 0 && tagInProject(sx, r.tag));
  if (!boxes.length) return null;
  const r = boxes[Math.min(boxes.length - 1, Math.floor(frac * boxes.length))];
  return { path: rel(tagInProject(sx, r.tag)), line: r.line };
}

function syncForward(file, line) {
  const sx = loadSynctex();
  const target = inRoot(file);
  const tags = [...sx.inputs].filter(([, abs]) => abs === target).map(([t]) => t);
  if (!tags.length) return null;
  let bestDelta = Infinity, hits = [];
  sx.pages.forEach((recs, page) => {
    if (!recs) return;
    for (const r of recs) {
      if (!tags.includes(r.tag) || r.line <= 0) continue;
      const delta = Math.abs(r.line - line) + (r.line < line ? 0.5 : 0);
      if (delta < bestDelta) { bestDelta = delta; hits = [{ page, r }]; }
      else if (delta === bestDelta) hits.push({ page, r });
    }
  });
  if (!hits.length) return null;
  const page = Math.min(...hits.map((h) => h.page));
  const onPage = hits.filter((h) => h.page === page).map((h) => h.r);
  const top = Math.min(...onPage.map((r) => r.y - (r.h || 8)));
  const bottom = Math.max(...onPage.map((r) => r.y + (r.d || 2)));
  const left = Math.min(...onPage.map((r) => r.x));
  return { page, x: left, y: top, h: Math.max(bottom - top, 10) };
}

// ---------------------------------------------------------------- claude code terminal

const CLAUDE_NOTE = () => [
  'You are running inside Underleaf, a local Overleaf-style LaTeX editor.',
  `The project root is the current directory and the main LaTeX file is ${MAIN}.`,
  'The user sees the LaTeX source on the left and the compiled PDF on the right.',
  'Any file you edit on disk is reloaded into their editor instantly and the project is recompiled automatically with Tectonic (XeTeX), so you normally do not need to compile yourself.',
  'After a build, .underleaf/errors.txt holds a summary of errors and warnings and .underleaf/*.log holds the full TeX log. Never delete the .underleaf directory.',
  'When the user refers to "lines N-M" they mean line numbers in the editor (1-based). Prefer small, targeted edits that keep their formatting.',
].join(' ');

const term = { proc: null, buffer: '', cols: 100, rows: 30 };

function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // If Underleaf itself was launched from inside Claude Code, don't leak that session into the new one.
  for (const k of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']) delete env[k];
  return env;
}

function startTerminal(extraArgs = []) {
  if (term.proc) return;
  term.buffer = '';
  let file, args;
  if (CLAUDE) {
    file = CLAUDE;
    args = ['--append-system-prompt', CLAUDE_NOTE(), ...extraArgs];
  } else {
    file = process.env.SHELL || '/bin/bash';
    args = [];
    term.buffer = '\x1b[33mclaude was not found on PATH — starting a shell instead.\x1b[0m\r\n';
  }
  try {
    term.proc = pty.spawn(file, args, { name: 'xterm-256color', cols: term.cols, rows: term.rows, cwd: ROOT, env: childEnv() });
  } catch (err) {
    broadcast({ type: 'term-out', data: `\r\n\x1b[31mCould not start ${file}: ${err.message}\x1b[0m\r\n` });
    return;
  }
  const proc = term.proc;
  proc.onData((d) => {
    term.buffer += d;
    if (term.buffer.length > 400_000) term.buffer = term.buffer.slice(-250_000);
    broadcast({ type: 'term-out', data: d });
  });
  proc.onExit(({ exitCode }) => {
    if (term.proc !== proc) return;
    term.proc = null;
    broadcast({ type: 'term-exit', code: exitCode });
  });
  broadcast({ type: 'term-started' });
}

// ---------------------------------------------------------------- texpresso live window

const live = { proc: null, onTop: null, spy: null, rect: null, underleafWin: null, startedAt: 0, refocused: false };
// TeXpresso only maps edit paths onto its document when they are absolute.
const absPath = (p) => path.resolve(ROOT, p);
const PYTHON = XPROP ? which('python3') : null;
const WINDOW_TOOL = path.join(APP_DIR, 'bin', 'x11-window.py');
const KEEP_TITLEBAR = flag('--titlebar');
let appWindow = null; // X11 id of the most recently registered Underleaf window

function liveSend(cmd) {
  if (live.proc?.stdin.writable) live.proc.stdin.write(JSON.stringify(cmd) + '\n');
}

function startLive(docs = []) {
  if (!TEXPRESSO || live.proc) return;
  rememberActiveUnderleaf();
  const proc = spawn(TEXPRESSO, ['-json', '-lines', '-tectonic', MAIN], { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  Object.assign(live, { proc, onTop: null, startedAt: Date.now(), refocused: false });
  proc.stdin.on('error', () => {});
  proc.on('error', (err) => {
    broadcast({ type: 'toast', level: 'error', text: `Live preview failed to start: ${err.message}` });
    if (live.proc === proc) { live.proc = null; stopFocusSpy(); broadcast({ type: 'live-state', running: false }); }
  });
  liveSend(['rerun', true]); // after 500ms idle, rerun if .aux changed so \ref and the TOC resolve
  for (const d of docs) liveSend(['open', absPath(d.path), d.content]);
  if (live.rect) placeLive(live.rect);
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // ["synctex", "/abs/path.tex", line, column] is sent when the user clicks the preview; lines are 1-based.
    if (msg[0] === 'synctex' && typeof msg[1] === 'string') {
      const abs = path.resolve(ROOT, msg[1]);
      if (abs.startsWith(ROOT + path.sep)) broadcast({ type: 'goto', path: rel(abs), line: Math.max(1, msg[2] || 1) });
      setTimeout(activateUnderleaf, 150); // give keyboard focus back to the editor
    }
  });
  proc.stderr.pipe(fs.createWriteStream(path.join(BUILD, 'texpresso.log')));
  proc.on('exit', () => {
    if (live.proc !== proc) return;
    live.proc = null;
    stopFocusSpy();
    broadcast({ type: 'live-state', running: false });
  });
  startFocusSpy();
  broadcast({ type: 'live-state', running: true });
}

function stopLive() {
  if (!live.proc) return;
  const p = live.proc;
  live.proc = null;
  stopFocusSpy();
  p.kill('SIGTERM');
  setTimeout(() => p.kill('SIGKILL'), 1500);
  broadcast({ type: 'live-state', running: false });
}

// map-window makes TeXpresso's window borderless and always-on-top, positioned over the preview pane.
function placeLive(rect) {
  live.rect = rect;
  if (!live.proc) return;
  const r = [rect.x, rect.y, rect.w, rect.h].map((v) => Math.max(0, Math.round(v)));
  if (live.onTop === false) {
    liveSend(['move-window', ...r]);
  } else {
    liveSend(['map-window', ...r]);
    live.onTop = true;
  }
}

function setOnTop(v) {
  if (live.onTop === v) return;
  live.onTop = v;
  liveSend(['stay-on-top', v]);
}

function windowInfo(id, cb) {
  execFile(XPROP, ['-id', id, '_NET_WM_PID', '_NET_WM_NAME'], (err, out) => {
    if (err) return cb(null);
    cb({ pid: +(out.match(/_NET_WM_PID\(CARDINAL\) = (\d+)/)?.[1] || 0), underleaf: /Underleaf"\s*$/m.test(out) });
  });
}

function rememberActiveUnderleaf() {
  if (!XPROP) return;
  execFile(XPROP, ['-root', '_NET_ACTIVE_WINDOW'], (err, out) => {
    const id = out?.match(/window id # (0x[0-9a-f]+)/i)?.[1];
    if (id) windowInfo(id, (w) => { if (w?.underleaf) live.underleafWin = id; });
  });
}

// Ask the window manager to activate the Underleaf window again.
function activateUnderleaf() {
  windowAction('activate', appWindow || live.underleafWin);
}

function windowAction(action, id) {
  if (PYTHON && id) execFile(PYTHON, [WINDOW_TOOL, action, id], () => {});
}

// The page briefly titles itself with a one-off key so we can find exactly its X11 window.
function findWindowByTitle(title, cb, tries = 24) {
  if (!XPROP) return cb(null);
  execFile(XPROP, ['-root', '_NET_CLIENT_LIST'], (err, out) => {
    const ids = err ? [] : out.match(/0x[0-9a-f]+/gi) || [];
    let left = ids.length;
    let found = null;
    const next = () => {
      if (found || tries <= 1) return cb(found);
      setTimeout(() => findWindowByTitle(title, cb, tries - 1), 250);
    };
    if (!left) return next();
    for (const id of ids) {
      execFile(XPROP, ['-id', id, '_NET_WM_NAME'], (_e, o) => {
        if (!found && o?.includes(`= "${title}"`)) found = id;
        if (--left === 0) next();
      });
    }
  });
}

// Underleaf draws its own header with window buttons, so drop the system title bar.
function undecorate(id) {
  if (!KEEP_TITLEBAR) execFile(XPROP, ['-id', id, '-f', '_MOTIF_WM_HINTS', '32c', '-set', '_MOTIF_WM_HINTS', '2, 0, 0, 0, 0'], () => {});
}

// Keep the docked window above other apps only while Underleaf (or TeXpresso itself) is active.
function startFocusSpy() {
  if (!XPROP || live.spy) return;
  const spy = spawn(XPROP, ['-spy', '-root', '_NET_ACTIVE_WINDOW']);
  live.spy = spy;
  spy.on('error', () => {});
  readline.createInterface({ input: spy.stdout }).on('line', (line) => {
    const id = line.match(/window id # (0x[0-9a-f]+)/i)?.[1];
    if (!id || id === '0x0') return;
    windowInfo(id, (w) => {
      if (!w || !live.proc) return;
      const isTexpresso = w.pid === live.proc.pid;
      if (w.underleaf && !isTexpresso) live.underleafWin = id;
      setOnTop(isTexpresso || w.underleaf);
      // TeXpresso's window grabs focus when it first opens; hand it back so typing continues in the editor.
      if (isTexpresso && !live.refocused && Date.now() - live.startedAt < 10_000) {
        live.refocused = true;
        setTimeout(activateUnderleaf, 100);
      }
    });
  });
  spy.on('exit', () => { if (live.spy === spy) live.spy = null; });
}

function stopFocusSpy() {
  live.spy?.kill();
  live.spy = null;
}

// ---------------------------------------------------------------- watcher

let filesTimer = null;
function refreshFiles() {
  clearTimeout(filesTimer);
  filesTimer = setTimeout(async () => {
    files = await listFiles();
    broadcast({ type: 'files', files, main: MAIN });
  }, 80);
}

const watcher = watch(ROOT, {
  ignoreInitial: true,
  ignored: (p) => { const r = rel(p); return r !== '' && isHiddenRel(r); },
  awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 15 },
  depth: 8,
});
watcher.on('add', async (abs) => {
  refreshFiles();
  const r = rel(abs);
  if (isText(r) && !lastKnown.has(r)) {
    try {
      const content = await fsp.readFile(abs, 'utf8');
      lastKnown.set(r, content);
      if (content) broadcast({ type: 'file-changed', path: r, content, previous: '' });
    } catch {}
  }
  if (BUILD_EXT.has(path.extname(abs).toLowerCase())) scheduleCompile();
});
watcher.on('unlink', (abs) => {
  const r = rel(abs);
  lastKnown.delete(r);
  refreshFiles();
  broadcast({ type: 'file-deleted', path: r });
  if (BUILD_EXT.has(path.extname(abs).toLowerCase())) scheduleCompile();
});
watcher.on('addDir', refreshFiles);
watcher.on('unlinkDir', refreshFiles);
watcher.on('change', async (abs) => {
  const r = rel(abs);
  if (!BUILD_EXT.has(path.extname(abs).toLowerCase())) return;
  if (isText(r)) {
    let content;
    try { content = await fsp.readFile(abs, 'utf8'); } catch { return; }
    const previous = lastKnown.get(r);
    if (content === previous || recentWrites.get(r)?.includes(content)) return;
    lastKnown.set(r, content);
    broadcast({ type: 'file-changed', path: r, content, previous: previous ?? null });
    if (live.proc) liveSend(['open', absPath(r), content]);
  }
  scheduleCompile();
});

// ---------------------------------------------------------------- http

const TOKEN = crypto.randomBytes(18).toString('hex');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' };

let PORT = 0;
const hostOk = (req) => [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host);

function send404(res) { res.writeHead(404); res.end('not found'); }

function serveFile(res, abs, extraHeaders = {}) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send404(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', ...extraHeaders });
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (!hostOk(req)) { res.writeHead(403); return res.end('forbidden'); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const authed = url.searchParams.get('t') === TOKEN;
  if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
  if (url.pathname.startsWith('/assets/')) {
    const abs = path.join(PUBLIC, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!abs.startsWith(PUBLIC + path.sep)) return send404(res);
    return serveFile(res, abs, { 'Cache-Control': 'no-cache' });
  }
  if (!authed) { res.writeHead(401); return res.end('unauthorized'); }
  if (url.pathname === '/pdf') return serveFile(res, pdfPath());
  if (url.pathname === '/download') {
    const name = path.basename(MAIN, path.extname(MAIN)) + '.pdf';
    return serveFile(res, pdfPath(), { 'Content-Disposition': `attachment; filename="${name}"` });
  }
  if (url.pathname === '/raw') {
    try { return serveFile(res, inRoot(url.searchParams.get('p') || '')); } catch { return send404(res); }
  }
  send404(res);
});

// ---------------------------------------------------------------- ws protocol

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const originOk = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin);
  if (!hostOk(req) || !originOk || url.pathname !== '/ws' || url.searchParams.get('t') !== TOKEN) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

let idleTimer = null;
const KEEP_ALIVE = flag('--keep');

wss.on('connection', (ws) => {
  clients.add(ws);
  clearTimeout(idleTimer);
  const reply = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  ws.on('close', () => {
    clients.delete(ws);
    if (clients.size) return;
    stopLive();
    if (!KEEP_ALIVE) idleTimer = setTimeout(shutdown, 20_000);
  });
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try { await handle(m, reply, ws); } catch (err) { reply({ type: 'toast', level: 'error', text: err.message }); }
  });
});

async function handle(m, reply, ws) {
  switch (m.type) {
    case 'hello':
      reply({
        type: 'init', root: ROOT, name: path.basename(ROOT), files, main: MAIN,
        texpresso: !!TEXPRESSO, claude: !!CLAUDE, tectonic: !!TECTONIC,
        compile: compile.last && { ...compile.last, version: compile.version }, compiling: compile.running,
        live: !!live.proc, terminalRunning: !!term.proc,
      });
      break;
    case 'open': {
      const abs = inRoot(m.path);
      if (!isText(m.path)) return reply({ type: 'opened', path: m.path, binary: true });
      const content = await fsp.readFile(abs, 'utf8');
      lastKnown.set(m.path, content);
      reply({ type: 'opened', path: m.path, content });
      break;
    }
    case 'save': {
      const abs = inRoot(m.path);
      if (lastKnown.get(m.path) === m.content) return reply({ type: 'saved', path: m.path, seq: m.seq });
      lastKnown.set(m.path, m.content);
      rememberWrite(m.path, m.content);
      await fsp.writeFile(abs, m.content);
      reply({ type: 'saved', path: m.path, seq: m.seq });
      scheduleCompile(m.immediate ? 0 : live.proc ? 1200 : 60);
      break;
    }
    case 'create': {
      const abs = inRoot(m.path);
      if (fs.existsSync(abs)) throw new Error(`${m.path} already exists`);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      lastKnown.set(m.path, '');
      await fsp.writeFile(abs, '');
      refreshFiles();
      reply({ type: 'created', path: m.path });
      break;
    }
    case 'set-main':
      if (!files.includes(m.path)) throw new Error(`${m.path} is not in the project`);
      MAIN = m.path;
      state.main = MAIN;
      saveState();
      synctexCache = null;
      broadcast({ type: 'files', files, main: MAIN });
      if (live.proc) { stopLive(); }
      scheduleCompile(0);
      break;
    case 'compile':
      scheduleCompile(0);
      break;
    case 'sync-backward':
      try { const hit = syncBackward(m.page, m.x, m.y); if (hit) reply({ type: 'goto', ...hit }); } catch {}
      break;
    case 'window-hello':
      findWindowByTitle(`underleaf-window:${m.key}`, (id) => {
        ws.windowId = id;
        if (id) { appWindow = id; undecorate(id); }
        reply({ type: 'window-ready', controls: !!(id && PYTHON && !KEEP_TITLEBAR) });
      });
      break;
    case 'win':
      if (!ws.windowId || !['minimize', 'maximize', 'close'].includes(m.action)) break;
      windowAction(m.action, ws.windowId);
      if (m.action === 'maximize') setTimeout(() => undecorate(ws.windowId), 300);
      break;
    case 'sync-range': {
      const out = { type: 'rpc', rid: m.rid };
      try {
        const a = syncBackward(m.a.page, m.a.x, m.a.y);
        const b = syncBackward(m.b.page, m.b.x, m.b.y);
        if (a) Object.assign(out, { path: a.path, from: Math.min(a.line, b?.path === a.path ? b.line : a.line), to: Math.max(a.line, b?.path === a.path ? b.line : a.line) });
      } catch {}
      reply(out);
      break;
    }
    case 'link-from-pdf': {
      let hit = null;
      try { hit = linkFromPdf(m.page, m.frac); } catch {}
      reply({ type: 'rpc', rid: m.rid, ...hit });
      break;
    }
    case 'link-from-source': {
      let hit = null;
      try { hit = syncForward(m.path, m.line); } catch {}
      reply({ type: 'rpc', rid: m.rid, ...(hit && { page: hit.page, x: hit.x, y: hit.y, h: hit.h }) });
      break;
    }
    case 'sync-forward':
      try { const hit = syncForward(m.path, m.line); if (hit) reply({ type: 'pdf-goto', ...hit }); } catch {}
      break;
    case 'term-start':
      term.cols = m.cols || term.cols;
      term.rows = m.rows || term.rows;
      if (term.proc) {
        term.proc.resize(term.cols, term.rows);
        reply({ type: 'term-replay', data: term.buffer });
      } else {
        startTerminal(m.args || []);
      }
      break;
    case 'term-restart':
      if (term.proc) { const p = term.proc; term.proc = null; p.kill(); }
      broadcast({ type: 'term-reset' });
      startTerminal(m.args || []);
      break;
    case 'term-in':
      term.proc?.write(m.data);
      break;
    case 'term-resize':
      term.cols = m.cols; term.rows = m.rows;
      try { term.proc?.resize(m.cols, m.rows); } catch {}
      break;
    case 'live-start':
      live.rect = m.rect || live.rect;
      startLive(m.docs || []);
      break;
    case 'live-stop':
      stopLive();
      break;
    case 'live-rect':
      placeLive(m.rect);
      break;
    case 'live-open':
      liveSend(['open', absPath(m.path), m.content]);
      break;
    case 'live-change':
      for (const c of m.changes) liveSend(['change-range', absPath(m.path), c[0], c[1], c[2], c[3], c[4]]);
      break;
    case 'live-forward':
      liveSend(['synctex-forward', absPath(m.path), Math.max(1, m.line)]);
      break;
    case 'live-ontop':
      if (live.proc) setOnTop(!!m.value);
      break;
  }
}

// ---------------------------------------------------------------- lifecycle

function shutdown() {
  stopLive();
  try { term.proc?.kill(); } catch {}
  compile.child?.kill('SIGKILL');
  watcher.close();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function openWindow(url) {
  const browsers = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'];
  const bin = process.env.UNDERLEAF_BROWSER || browsers.map((b) => which(b)).find(Boolean);
  if (!bin) {
    const xdg = which('xdg-open');
    if (xdg) spawn(xdg, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return;
  }
  const profile = path.join(DATA_DIR, 'chrome-profile');
  fs.mkdirSync(profile, { recursive: true });
  spawn(bin, [`--app=${url}`, `--user-data-dir=${profile}`, '--class=Underleaf', '--no-first-run', '--no-default-browser-check', '--window-size=1500,940'],
    { detached: true, stdio: 'ignore' }).on('error', () => console.log(`Could not open a browser window; open the URL above.`)).unref();
}

const requestedPort = +(opt('--port') || process.env.UNDERLEAF_PORT || 0);
server.listen(requestedPort, '127.0.0.1', () => {
  PORT = server.address().port;
  const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  console.log(`Underleaf · ${ROOT}`);
  console.log(`  main file   ${MAIN}`);
  console.log(`  tectonic    ${TECTONIC || 'not found'}`);
  console.log(`  texpresso   ${TEXPRESSO || 'not found (live mode off)'}`);
  console.log(`  claude      ${CLAUDE || 'not found'}`);
  console.log(`  open        ${url}`);
  if (!flag('--no-open')) openWindow(url);
  scheduleCompile(0);
  // If nobody ever connects, don't linger forever.
  if (!KEEP_ALIVE) idleTimer = setTimeout(() => { if (!clients.size) shutdown(); }, 120_000);
});
