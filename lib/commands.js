// Finding and starting external programs, on Unix and on Windows.
import fs from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

export function findCommand(name, dirs, { win32 = isWindows } = {}) {
  const exts = win32 ? ['.exe', '.cmd', '.bat'] : [''];
  // An empty PATH entry would mean the current folder, and a project must not supply its own tools.
  for (const dir of dirs.filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
    }
  }
  return null;
}

// The program an npm .cmd wrapper really runs, relative to the wrapper. Null if it isn't such a wrapper.
export function shimTarget(text) {
  const targets = [...text.matchAll(/"%~?dp0%?\\([^"]+\.(?:[cm]?js|exe))"/gi)].map((m) => m[1]);
  return targets.filter((t) => !/^node\.exe$/i.test(t)).at(-1) ?? null;
}

// cmd.exe re-parses every argument passed through a batch file, and agents are handed the project's
// file names, so `a&calc.tex` would run calc. Start what the wrapper points at instead.
export function launchCommand(file, args, { win32 = isWindows, read = (f) => fs.readFileSync(f, 'utf8'), node = process.execPath } = {}) {
  if (!win32 || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  const target = shimTarget(read(file));
  if (!target) throw new Error(`${path.win32.basename(file)} is a batch file Underleaf can't start safely`);
  const abs = path.win32.join(path.win32.dirname(file), target);
  return /\.exe$/i.test(abs) ? { file: abs, args } : { file: node, args: [abs, ...args] };
}
