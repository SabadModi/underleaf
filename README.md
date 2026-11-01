# Underleaf

A local Overleaf. Your LaTeX source on the left, the compiled PDF on the right, and Claude Code in a
panel underneath — all running on your own machine, on your own files. It compiles with
[Tectonic](https://tectonic-typesetting.github.io), so there is no TeX Live install to manage, and it can
optionally borrow [TeXpresso](https://github.com/let-def/texpresso) for a preview that redraws as you type.

Claude edits the files on disk; the editor reloads them, recompiles, and shows you every change as a
before/after you can keep or undo.

## Requirements

On every platform you need:

- **Node 20 or newer**.
- **[Tectonic](https://tectonic-typesetting.github.io/en-US/install.html)** on your PATH — the LaTeX engine.
- **Chrome or Chromium** — the app opens in its own window. Any Chromium-based browser works, including the
  Edge that comes with Windows.
- **Optional: [Claude Code](https://claude.com/claude-code)** (`claude` on your PATH) and/or
  [Codex](https://github.com/openai/codex) (`codex` on your PATH) for the agent panel. With neither, that panel
  just runs your shell.
- **Optional: [pandoc](https://pandoc.org/installing.html) 2.11 or newer** to write in Markdown instead of LaTeX.

What works where:

| | Linux (X11) | Linux (Wayland), macOS | Windows 10/11 (experimental) |
|---|---|---|---|
| Editor, PDF preview, review panel, agent panel | Yes | Yes | Should work, not tested yet |
| Live mode | Yes | No | No |
| Window buttons in the header | Yes | No | No |

## Install

### Linux

```
sudo apt install build-essential python3    # Debian/Ubuntu: the terminal compiles a native module
git clone https://github.com/SabadModi/underleaf.git
cd underleaf
./scripts/install.sh
```

That installs dependencies, builds the front end, adds an `underleaf` command to `~/.local/bin`, and
creates an app-menu entry.

For Markdown, `sudo apt install pandoc` is new enough on Ubuntu 24.04; on older releases use the `.deb` from
pandoc's site.

### macOS

```
xcode-select --install    # the terminal compiles a native module
git clone https://github.com/SabadModi/underleaf.git
cd underleaf
./scripts/install.sh
```

That installs dependencies, builds the front end and adds an `underleaf` command to `~/.local/bin`. Chrome
isn't on your PATH on macOS, so Underleaf prints a URL for you to open. To get its own window instead, add
this to your shell profile:

```
export UNDERLEAF_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

### Windows

Windows support is new and hasn't been run on a real Windows machine yet, so expect rough edges. From
PowerShell:

```
git clone https://github.com/SabadModi/underleaf.git
cd underleaf
npm run setup:windows
```

That installs dependencies, builds the front end and adds `bin\` to your user PATH, so open a new terminal
afterwards. There is no Start menu entry, so start it from a terminal.

For the Linux setup on Windows instead, follow the Linux steps inside WSL2.

### Without installing

On any platform, run `npm install`, then `npm start`.

## Run

Linux and macOS:

```
underleaf ~/papers/thesis        # a project folder (the main file is detected)
underleaf ~/papers/note.tex      # a specific main file (created from a template if missing)
underleaf ~/notes/draft.md       # a Markdown main file (also created if missing)
underleaf                        # the current folder
```

Windows:

```
underleaf C:\papers\thesis
underleaf C:\papers\note.tex
underleaf C:\notes\draft.md
underleaf
```

## Optional: live preview (Linux with X11)

The **Live** button re-renders on every keystroke using TeXpresso, which is built from source (no sudo,
nothing installed system-wide):

```
sudo apt install libsdl2-dev libfreetype-dev libharfbuzz-dev libgraphite2-dev \
                 libicu-dev libpng-dev libfontconfig-dev libjpeg-dev x11-utils
./scripts/build-texpresso.sh
```

It compiles MuPDF and TeXpresso into `~/.local/share/underleaf/deps` (a few minutes) and applies
`patches/texpresso-live-fixes.patch`. TeXpresso is a separate project under
[its own license](https://github.com/let-def/texpresso/blob/main/LICENSE).

## What you get

- **Editor**: CodeMirror 6 with LaTeX highlighting, autocomplete for commands, environments, `\ref` labels and `\cite` keys from your `.bib` files. Edits autosave to disk.
- **PDF preview**: recompiles with [Tectonic](https://tectonic-typesetting.github.io) as you type; a short document is back on screen about a second after a keystroke. Errors show in the gutter and in the error list; click one to jump to it.
- **Live mode** (`Live` button, `Ctrl+Shift+L`): [TeXpresso](https://github.com/let-def/texpresso) docks its window over the preview and re-renders on every keystroke, typically within a few hundred milliseconds.
- **Markdown**: a `.md` file can be the main document too (`underleaf draft.md`, or **set main** in the file list). pandoc turns it into LaTeX and Tectonic compiles that, so the preview, error list, highlights and Claude all work the same. You write [pandoc Markdown](https://pandoc.org/MANUAL.html#pandoc-s-markdown): `$math$`, raw LaTeX such as `\newpage`, `[@key]` citations with `bibliography: refs.bib` in the YAML header, and `title`/`author`/`geometry` there too. Jumping between the PDF and the source lands on the right block, usually the right line. Live mode is LaTeX-only. A folder with no `.tex` file at all opens its Markdown (`main.md`, `index.md`, else the least-nested `.md`).
- **Claude Code or Codex**: the real `claude` or `codex` CLI, running in the project folder. It knows it is inside Underleaf, and anything it changes on disk reloads in the editor and recompiles right away. The switch in the panel's header flips between the two; each keeps its own session running, and the project remembers which one you used last. Labels, Ask (`Ctrl+K`) and the chips all follow the switch.

## Keys

| Keys | Action |
| --- | --- |
| `Ctrl+K` | Ask Claude about the selected lines |
| `Ctrl+S` / `Ctrl+Enter` | Save and recompile now |
| `Alt+Enter` | Show the cursor's line in the PDF |
| Double-click the PDF | Jump to that line in the source |
| Select text in the PDF | Toolbar: Ask Claude, Highlight, Go to source (`Ctrl+K` asks too) |
| Link scroll switch (preview header) | Scroll the LaTeX along with the PDF, and the PDF along with the LaTeX |
| `Ctrl+Shift+L` | Toggle live mode |
| ``Ctrl+` `` | Show or hide Claude Code |

Highlights stay on the PDF through zoom and recompiles (they disappear once their text is edited away); the highlight chip in the preview header asks Claude about all of them at once. When you ask about PDF text, Claude gets the quote plus the matching source lines.

When a file changes on disk (Claude editing it), the editor switches to a review: removed text in red, new text in green, Keep/Undo on each change, and Keep all / Undo all in the bar above. Files with unreviewed edits get a dot in the file list, and the PDF shows green change bars in the margin next to the edited passages.

The chips above the Claude panel send ready-made requests: ask about the selection, review the current file, or fix the build errors (Claude reads them from `.underleaf/errors.txt`).

## Files it creates

Build output lives in `<project>/.underleaf/` (git-ignored automatically): the PDF, SyncTeX data, the TeX log, `errors.txt` and `texpresso.log`.

## How it's put together

- `server.js`: Node server on 127.0.0.1 with a random port and access token. Runs Tectonic, parses errors and SyncTeX, watches the folder, hosts the `claude` terminal (node-pty) and drives TeXpresso over its JSON protocol.
- `src/`: the browser app (CodeMirror, pdf.js, xterm.js), bundled by `node build.mjs` into `public/assets/`.
- `bin/underleaf`, `bin/underleaf.cmd`: launchers; the app opens in a Chrome/Chromium `--app` window with its own profile.
- `bin/x11-window.py`: tiny X11 helper behind the header's minimize/maximize/close buttons (the system title bar is removed; start with `--titlebar` to keep it) and the focus hand-back from TeXpresso's window.

## Live mode build

TeXpresso is built from source into `~/.local/share/underleaf/deps` with `scripts/build-texpresso.sh` (no sudo; it also builds MuPDF). The build applies `patches/texpresso-live-fixes.patch`, which fixes two upstream bugs:

1. Typing faster than a render could finish froze the preview (a killed root worker was never respawned).
2. `\input{chapter}` without `.tex` was read behind TeXpresso's back, so edits to included files never showed up.

Live mode needs X11 (it uses `xprop` to keep the docked window above Underleaf only while Underleaf is focused).

## Reinstall

```
scripts/install.sh   # npm deps, build, ~/.local/bin/underleaf, app-menu entry
```
