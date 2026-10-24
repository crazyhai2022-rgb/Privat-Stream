#!/usr/bin/env bash
# Install static ffmpeg + ffprobe into your home directory — no root needed.
#
# For shared hosting (cPanel, Hostinger, etc.) where you cannot apt-get install anything.
# Run it over SSH on the hosting account:
#
#   bash deploy/install-ffmpeg-static.sh
#
# It prints the two environment variables to paste into cPanel → Setup Node.js App.

set -euo pipefail

DEST="${FFMPEG_DIR:-$HOME/bin}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

printf '\033[1mInstalling static ffmpeg into %s\033[0m\n' "$DEST"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) BUILD=amd64 ;;
  aarch64|arm64) BUILD=arm64 ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac
[ "$(uname -s)" = "Linux" ] || die "This script is for Linux hosting accounts."

URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${BUILD}-static.tar.xz"
info "Downloading ${BUILD} build…"
if command -v curl >/dev/null; then curl -fsSL "$URL" -o "$TMP/ffmpeg.tar.xz"
elif command -v wget >/dev/null; then wget -q "$URL" -O "$TMP/ffmpeg.tar.xz"
else die "Neither curl nor wget is available."
fi

info "Extracting…"
tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP" || die "Extract failed (is xz available?)."
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'ffmpeg-*-static' | head -1)"
[ -n "$SRC" ] || die "Unexpected archive layout."

mkdir -p "$DEST"
install -m 755 "$SRC/ffmpeg" "$DEST/ffmpeg"
install -m 755 "$SRC/ffprobe" "$DEST/ffprobe"

# Shared hosts sometimes mount the home directory noexec, which silently breaks this.
if ! "$DEST/ffmpeg" -version >/dev/null 2>&1; then
  die "ffmpeg installed but will not execute here (the home directory may be mounted noexec).
  Ask support whether running binaries from \$HOME is allowed, or set REQUIRE_FFMPEG=false
  and read docs/CPANEL.md for what stops working."
fi

VER="$("$DEST/ffmpeg" -version | head -1 | cut -d' ' -f3)"
printf '\033[1m\nDone — ffmpeg %s is working.\033[0m\n\n' "$VER"
info "Add these two environment variables to your Node.js app in cPanel:"
echo
echo "  FFMPEG_PATH=$DEST/ffmpeg"
echo "  FFPROBE_PATH=$DEST/ffprobe"
echo
info "Then restart the app. Uploads will get thumbnails, duration checks and streaming versions."
