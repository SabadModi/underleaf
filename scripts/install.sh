#!/usr/bin/env bash
# Installs the `underleaf` command (~/.local/bin) and an "Underleaf" app-menu entry.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)" || { echo "underleaf: node is not on PATH — install Node 20 or newer" >&2; exit 1; }
if [[ "$("$NODE" -p 'parseInt(process.versions.node)')" -lt 20 ]]; then
  echo "underleaf: Node 20 or newer is required (found $("$NODE" -v))" >&2
  exit 1
fi
# node-pty (the Claude terminal) has no Linux prebuilt binary, so npm compiles it here.
missing=()
for tool in python3 make g++; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "underleaf: missing build tools: ${missing[*]}" >&2
  echo "  Debian/Ubuntu: sudo apt install build-essential python3" >&2
  exit 1
fi

cd "$APP_DIR"
[[ -d node_modules ]] || npm install --no-audit --no-fund
"$NODE" build.mjs

mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps"

# Pin the node that built node-pty, so launching from the app menu (no nvm in PATH) still works.
cat > "$HOME/.local/bin/underleaf" <<WRAP
#!/usr/bin/env bash
UNDERLEAF_NODE="$NODE" exec "$APP_DIR/bin/underleaf" "\$@"
WRAP
chmod +x "$HOME/.local/bin/underleaf"

cat > "$HOME/.local/share/icons/hicolor/scalable/apps/underleaf.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#14171c"/><path d="M17 47c0-18 11-28 31-30-2 18-12 30-31 30z" fill="#d6a64f"/><path d="M17 47l16-16" stroke="#14171c" stroke-width="3" stroke-linecap="round"/></svg>
SVG

cat > "$HOME/.local/share/applications/underleaf.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Underleaf
Comment=LaTeX editor with live PDF preview and Claude Code
Exec=$HOME/.local/bin/underleaf %f
Icon=underleaf
Terminal=false
Categories=Office;Publishing;
MimeType=text/x-tex;
StartupWMClass=Underleaf
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

command -v tectonic >/dev/null || cat >&2 <<'TEX'

Tectonic (the LaTeX engine) was not found on PATH. Underleaf runs without it, but nothing will
compile. Install it from https://tectonic-typesetting.github.io/en-US/install.html
(for example: cargo install tectonic), then start Underleaf again.
TEX

if [[ ! -x "$HOME/.local/share/underleaf/deps/texpresso/build/texpresso" ]]; then
  echo "Optional: run scripts/build-texpresso.sh to enable the Live preview button (Linux/X11)."
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Note: $HOME/.local/bin is not on your PATH; add it to use the 'underleaf' command." ;;
esac
echo "Installed. Run: underleaf ~/path/to/project   (or open Underleaf from the app menu)"
