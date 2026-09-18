#!/usr/bin/env bash
# Builds TeXpresso (the instant live preview) into ~/.local/share/underleaf/deps without sudo.
# MuPDF is built from source because Ubuntu's libmupdf-dev isn't installed by default;
# everything else it needs (SDL2, freetype, harfbuzz, ICU, graphite2) comes from the system.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="${UNDERLEAF_DEPS:-$HOME/.local/share/underleaf/deps}"
MUPDF_VERSION=1.28.4
TEXPRESSO_COMMIT=e8df7709077b2f86f6e16e6c86ceefb86de06f8d
JOBS="$(nproc)"
mkdir -p "$DEPS"

if [[ ! -f "$DEPS/mupdf/lib/libmupdf.a" ]]; then
  echo "==> building MuPDF $MUPDF_VERSION"
  cd "$DEPS"
  curl -fsSL -o mupdf.tar.gz "https://mupdf.com/downloads/archive/mupdf-$MUPDF_VERSION-source.tar.gz"
  tar xzf mupdf.tar.gz
  make -C "mupdf-$MUPDF_VERSION-source" -j"$JOBS" HAVE_X11=no HAVE_GLUT=no HAVE_GLFW=no HAVE_CURL=no \
    HAVE_OBJCOPY=no USE_TESSERACT=no XCFLAGS=-fPIC build=release prefix="$DEPS/mupdf" install-libs
fi

if [[ ! -d "$DEPS/texpresso/.git" ]]; then
  echo "==> fetching TeXpresso"
  git clone -q https://github.com/let-def/texpresso.git "$DEPS/texpresso"
  git -C "$DEPS/texpresso" checkout -q "$TEXPRESSO_COMMIT"
  # Fixes: live preview froze on fast typing; \input{file} without .tex never refreshed.
  git -C "$DEPS/texpresso" apply "$APP_DIR/patches/texpresso-live-fixes.patch"
fi

echo "==> building TeXpresso"
cd "$DEPS/texpresso"
mkdir -p build/objects
{
  echo "CFLAGS=-O2 -ggdb -I. -fPIC -I$DEPS/mupdf/include"
  echo 'CC=gcc $(CFLAGS)'
  echo 'LDCC=g++ $(CFLAGS)'
  echo "LIBS=-L$DEPS/mupdf/lib -lmupdf -lmupdf-third -lm -lz -ljpeg -lharfbuzz -lfreetype -lSDL2"
} > Makefile.config
make -j"$JOBS" common texpresso texpresso-xetex
echo "==> done: $DEPS/texpresso/build/texpresso"
