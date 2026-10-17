#!/bin/sh
# Grounded Core installer - Linux and macOS.
#
#   curl -fsSL https://getgrounded.dev/install.sh | sh
#   curl -fsSL https://getgrounded.dev/install.sh | sh -s -- --version 0.1.0 --prefix ~/bin
#
# Downloads the release tarball for this os-arch from GitHub Releases, verifies its size and
# sha256 against the release manifest and SHA256SUMS, unpacks it to
# $GROUNDED_HOME/lib/<version>/, flips $GROUNDED_HOME/lib/current to it, and puts a `grounded`
# launcher in the bin dir (default ~/.local/bin). It starts nothing: run `grounded install` next.
#
# The tarball runs on the host's Node and carries a native module built for one Node ABI, so the
# installer refuses a Node whose ABI differs from the release build. It never installs Node.
# Windows: use the Grounded Companion app.
#
# Everything lives in main(), called on the last line, so a truncated download runs nothing.

set -eu

REPO="flexxdev3/grounded-core"
RELEASES="https://github.com/$REPO/releases"
WRAPPER_MARK="# grounded-core install.sh launcher"

say() { printf '%s\n' "$*"; }
info() { printf 'grounded: %s\n' "$*"; }
warn() { printf 'grounded: warning: %s\n' "$*" >&2; }
die() { printf 'grounded: error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Grounded Core installer (Linux, macOS)

usage: install.sh [--version X] [--prefix DIR] [--help]

  --version X    install release X (e.g. 0.1.0); default: the latest release
  --prefix DIR   directory for the `grounded` launcher; default: ~/.local/bin
  -h, --help     show this help

environment:
  GROUNDED_VERSION   same as --version
  GROUNDED_HOME      install root; default ~/.grounded (runtime goes to $GROUNDED_HOME/lib/<version>/).
                     ~/.grounded holds config, models and runtime only; your data lives in
                     ~/Grounded/Cabinet. A custom GROUNDED_HOME keeps its data in $GROUNDED_HOME/cabinet.
  NODE               node binary to check and run with; default: node on PATH

Starts no service. Afterwards run `grounded install`.
EOF
}

# ---- state the EXIT trap reads ---------------------------------------------------------------
TMP=""            # download + staging dir, always removed
STAGE_DIR=""      # unpack dir inside $LIB before it is renamed into place
NEW_VERSION_DIR=""  # $LIB/<version>, set only once it was moved into place by this run
OLD_ASIDE=""      # previous copy of $LIB/<version> moved aside during a same-version reinstall
CREATED_DIRS=""   # dirs this run created; removed on failure if still empty
PREV_CURRENT=""   # previous lib/current target, restored on failure after the flip
FLIPPED=0
DONE=0

cleanup() {
  status=$?
  [ -n "$TMP" ] && rm -rf "$TMP"
  if [ "$DONE" -ne 1 ]; then
    [ -n "$STAGE_DIR" ] && rm -rf "$STAGE_DIR"
    if [ "$FLIPPED" -eq 1 ]; then
      if [ -n "$PREV_CURRENT" ]; then
        ln -s "$PREV_CURRENT" "$LIB/.current.$$" 2>/dev/null && swap_link "$LIB/.current.$$" "$LIB/current" 2>/dev/null || true
      else
        rm -f "$LIB/current"
      fi
    fi
    if [ -n "$NEW_VERSION_DIR" ]; then
      rm -rf "$NEW_VERSION_DIR"
      [ -n "$OLD_ASIDE" ] && mv "$OLD_ASIDE" "$NEW_VERSION_DIR" 2>/dev/null || true
    fi
    rm -f "${LIB:-/nonexistent}/.current.$$"
    # newest first, so a created parent is empty by the time it is tried
    for d in $CREATED_DIRS; do rmdir "$d" 2>/dev/null || true; done
    [ "$status" -eq 0 ] && status=1
  else
    [ -n "$OLD_ASIDE" ] && rm -rf "$OLD_ASIDE"
  fi
  exit "$status"
}

# mkdir -p that records every level it creates (newest first) for cleanup
make_dir() {
  [ -d "$1" ] && return 0
  make_dir "$(dirname "$1")"
  mkdir "$1" || die "cannot create $1"
  CREATED_DIRS="$1 $CREATED_DIRS"
}

# atomic rename of a symlink over a symlink (plain mv would follow the old link into its directory)
swap_link() {
  case "$OS" in
    darwin) mv -hf "$1" "$2" ;;
    *) mv -Tf "$1" "$2" ;;
  esac
}

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "need curl or wget to download"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else
    die "need sha256sum, shasum or openssl to verify the download"
  fi
}

# best effort, no node: built_with_node of the os-arch asset in a manifest (any JSON layout)
manifest_node_hint() { # manifest os arch
  tr -d '\n\r' <"$1" | awk -v os="$2" -v arch="$3" 'BEGIN { RS = "}" }
    function val(k,   s) {
      if (!match($0, "\"" k "\"[ \t]*:[ \t]*\"[^\"]*\"")) return ""
      s = substr($0, RSTART, RLENGTH); sub(/^"[^"]*"[ \t]*:[ \t]*"/, "", s); sub(/"$/, "", s); return s
    }
    val("os") == os && val("arch") == arch { print val("built_with_node"); exit }'
}

main() {
  VERSION="${GROUNDED_VERSION:-}"
  PREFIX=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
      --version=*) VERSION="${1#*=}"; shift ;;
      --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; PREFIX="$2"; shift 2 ;;
      --prefix=*) PREFIX="${1#*=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown argument: $1" ;;
    esac
  done

  [ -n "${HOME:-}" ] || die "HOME is not set"
  VERSION="${VERSION#v}"
  [ "$VERSION" = latest ] && VERSION=""
  case "$VERSION" in
    *[!0-9A-Za-z.+-]*) die "invalid version: $VERSION" ;;
  esac
  HOME_DIR="${GROUNDED_HOME:-$HOME/.grounded}"
  PREFIX="${PREFIX:-$HOME/.local/bin}"
  case "$HOME_DIR" in /*) ;; *) HOME_DIR="$(pwd)/$HOME_DIR" ;; esac
  case "$PREFIX" in /*) ;; *) PREFIX="$(pwd)/$PREFIX" ;; esac
  LIB="$HOME_DIR/lib"
  # both paths are written into the launcher script
  case "$HOME_DIR$PREFIX" in
    *[\"\\\`\$]*) die "GROUNDED_HOME and --prefix must not contain quotes, backslashes, backticks or \$" ;;
  esac

  # ---- platform ----
  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) die "Windows is not supported by this script - install the Grounded Companion app: $RELEASES" ;;
    *) die "unsupported OS: $(uname -s). Build from source: https://github.com/$REPO" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "unsupported CPU architecture: $(uname -m). Build from source: https://github.com/$REPO" ;;
  esac

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/grounded-install.XXXXXX")" || die "cannot create a temp dir"

  # ---- manifest ----
  if [ -n "$VERSION" ]; then
    BASE="$RELEASES/download/v$VERSION"
  else
    BASE="$RELEASES/latest/download"
  fi
  info "reading release manifest ${VERSION:+for v$VERSION }($BASE/manifest.json)"
  fetch "$BASE/manifest.json" "$TMP/manifest.json" \
    || die "could not download $BASE/manifest.json${VERSION:+ - is v$VERSION a published release? See $RELEASES}"

  # asset names are fixed by scripts/package.mjs: grounded-<version>-<os>-<arch>.tar.gz
  if ! grep -q "grounded-[^\"/]*-$OS-$ARCH\.tar\.gz" "$TMP/manifest.json"; then
    if [ "$OS" = darwin ]; then
      die "this release has no macOS ($OS-$ARCH) build yet - a macOS build is coming. Watch $RELEASES"
    fi
    die "this release has no build for $OS-$ARCH. See $RELEASES or build from source: https://github.com/$REPO"
  fi

  # ---- node ----
  NODE_BIN="${NODE:-node}"
  if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    hint="$(manifest_node_hint "$TMP/manifest.json" "$OS" "$ARCH" 2>/dev/null || true)"
    major="$(printf '%s' "$hint" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\).*/\1/p')"
    die "Node.js not found. Grounded runs on the system Node${major:+ and this release needs Node $major (built with $hint)}. Install it from https://nodejs.org (or your package manager), then re-run."
  fi

  # node is present: parse the manifest properly
  "$NODE_BIN" -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const a = (m.assets || []).find((x) => x.os === process.argv[2] && x.arch === process.argv[3] && /\.tar\.gz$/.test(x.name));
    if (!a) process.exit(3);
    const out = [m.version, a.name, a.url, a.sha256, a.size, a.node_abi, a.built_with_node || ""].map(String);
    if (out.some((v) => /[\n\r]/.test(v))) process.exit(4);
    process.stdout.write(out.join("\n") + "\n");
  ' "$TMP/manifest.json" "$OS" "$ARCH" >"$TMP/asset" || die "manifest has no usable $OS-$ARCH asset"
  {
    read -r REL_VERSION; read -r ASSET_NAME; read -r ASSET_URL; read -r ASSET_SHA
    read -r ASSET_SIZE; read -r ASSET_ABI; read -r ASSET_NODE
  } <"$TMP/asset"
  case "$REL_VERSION" in ""|*[!0-9A-Za-z.+-]*) die "manifest has an invalid version: $REL_VERSION" ;; esac
  case "$ASSET_NAME" in ""|*/*|.*) die "manifest has an invalid asset name: $ASSET_NAME" ;; esac
  case "$ASSET_URL" in https://*) ;; *) die "manifest asset url is not https: $ASSET_URL" ;; esac
  case "$ASSET_SIZE" in ""|*[!0-9]*) die "manifest asset size is not a number: $ASSET_SIZE" ;; esac
  printf '%s' "$ASSET_SHA" | grep -Eq '^[0-9a-f]{64}$' || die "manifest asset sha256 is malformed"

  NODE_ABI="$("$NODE_BIN" -p process.versions.modules 2>/dev/null || true)"
  NODE_VER="$("$NODE_BIN" -p process.version 2>/dev/null || true)"
  NEED_MAJOR="$(printf '%s' "$ASSET_NODE" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\).*/\1/p')"
  if [ "$NODE_ABI" != "$ASSET_ABI" ]; then
    die "Grounded $REL_VERSION for $OS-$ARCH needs Node ${NEED_MAJOR:-with ABI $ASSET_ABI} (built with ${ASSET_NODE:-unknown}, ABI $ASSET_ABI), but $(command -v "$NODE_BIN") is ${NODE_VER:-unknown} (ABI ${NODE_ABI:-unknown}). Install Node ${NEED_MAJOR:-$ASSET_ABI} and re-run (or point NODE=/path/to/node at one)."
  fi

  # ---- preflight the destination before downloading anything big ----
  if [ -e "$PREFIX/grounded" ] || [ -L "$PREFIX/grounded" ]; then
    if ! grep -q "^$WRAPPER_MARK" "$PREFIX/grounded" 2>/dev/null; then
      die "$PREFIX/grounded exists and was not written by this installer - remove it or pick another --prefix"
    fi
  fi

  # ---- download + verify ----
  info "downloading $ASSET_NAME ($ASSET_SIZE bytes)"
  fetch "$ASSET_URL" "$TMP/$ASSET_NAME" || die "download failed: $ASSET_URL"
  got_size="$(wc -c <"$TMP/$ASSET_NAME" | tr -d ' ')"
  [ "$got_size" = "$ASSET_SIZE" ] || die "size mismatch for $ASSET_NAME: expected $ASSET_SIZE, got $got_size - refusing to install"
  got_sha="$(sha256_of "$TMP/$ASSET_NAME")"
  [ "$got_sha" = "$ASSET_SHA" ] || die "sha256 mismatch for $ASSET_NAME: manifest $ASSET_SHA, download $got_sha - refusing to install"
  fetch "$RELEASES/download/v$REL_VERSION/SHA256SUMS" "$TMP/SHA256SUMS" || die "could not download SHA256SUMS for v$REL_VERSION"
  sums_sha="$(awk -v n="$ASSET_NAME" '$2 == n || $2 == "*" n { print $1; exit }' "$TMP/SHA256SUMS")"
  [ "$sums_sha" = "$got_sha" ] || die "sha256 mismatch for $ASSET_NAME: SHA256SUMS ${sums_sha:-has no entry}, download $got_sha - refusing to install"
  info "verified sha256 $got_sha"

  # ---- unpack into a staging dir, check it, then move into place ----
  mkdir "$TMP/x"
  tar -xzf "$TMP/$ASSET_NAME" -C "$TMP/x" || die "could not unpack $ASSET_NAME"
  for f in bin/grounded lib/cli.mjs lib/api.mjs release.json; do
    [ -f "$TMP/x/$f" ] || die "$ASSET_NAME is missing $f - refusing to install"
  done
  "$NODE_BIN" "$TMP/x/lib/cli.mjs" --version >/dev/null 2>&1 || die "the unpacked CLI does not run on $NODE_VER"

  make_dir "$LIB"
  make_dir "$PREFIX"
  [ -w "$PREFIX" ] || die "$PREFIX is not writable - pick another --prefix"
  STAGE_DIR="$LIB/.staging.$$"
  rm -rf "$STAGE_DIR"
  mv "$TMP/x" "$STAGE_DIR" 2>/dev/null || { mkdir "$STAGE_DIR" && cp -R "$TMP/x/." "$STAGE_DIR/"; } \
    || die "cannot write to $LIB"
  chmod 755 "$STAGE_DIR/bin/grounded"

  DEST="$LIB/$REL_VERSION"
  if [ -e "$LIB/current" ] && [ ! -L "$LIB/current" ]; then
    die "$LIB/current exists and is not a symlink - move it away and re-run"
  fi
  if [ -L "$LIB/current" ]; then
    PREV_CURRENT="$(readlink "$LIB/current")"
  fi
  if [ -e "$DEST" ]; then
    OLD_ASIDE="$LIB/.old.$REL_VERSION.$$"
    mv "$DEST" "$OLD_ASIDE"
  fi
  mv "$STAGE_DIR" "$DEST"
  STAGE_DIR=""
  NEW_VERSION_DIR="$DEST"

  # ---- flip current (relative link: the home stays relocatable) ----
  rm -f "$LIB/.current.$$"
  ln -s "$REL_VERSION" "$LIB/.current.$$"
  swap_link "$LIB/.current.$$" "$LIB/current"
  FLIPPED=1

  # ---- launcher (a script, not a symlink: the tarball's shim resolves lib/ from its own path) ----
  {
    printf '#!/bin/sh\n%s\n' "$WRAPPER_MARK"
    if [ "$HOME_DIR" != "$HOME/.grounded" ]; then
      # shellcheck disable=SC2016 # literal: expanded when the launcher runs
      printf ': "${GROUNDED_HOME:=%s}"\nexport GROUNDED_HOME\n' "$HOME_DIR"
    fi
    printf 'exec "%s/current/bin/grounded" "$@"\n' "$LIB"
  } >"$PREFIX/.grounded.$$"
  chmod 755 "$PREFIX/.grounded.$$"
  mv -f "$PREFIX/.grounded.$$" "$PREFIX/grounded"

  DONE=1

  if [ -n "$PREV_CURRENT" ] && [ "$PREV_CURRENT" != "$REL_VERSION" ]; then
    info "upgraded $PREV_CURRENT -> $REL_VERSION (previous runtime kept in $LIB/$PREV_CURRENT)"
  elif [ -n "$PREV_CURRENT" ]; then
    info "reinstalled $REL_VERSION"
  else
    info "installed $REL_VERSION"
  fi
  say "  runtime   $DEST"
  say "  current   $LIB/current -> $REL_VERSION"
  say "  launcher  $PREFIX/grounded"
  say "  node      $(command -v "$NODE_BIN") $NODE_VER"

  case ":$PATH:" in
    *":$PREFIX:"*)
      found="$(command -v grounded 2>/dev/null || true)"
      if [ -n "$found" ] && [ "$found" != "$PREFIX/grounded" ]; then
        warn "another grounded comes first on PATH: $found"
      fi
      run=grounded ;;
    *)
      warn "$PREFIX is not on your PATH. Add it, e.g. in ~/.profile (or ~/.zshrc):"
      say "    export PATH=\"$PREFIX:\$PATH\""
      run="$PREFIX/grounded" ;;
  esac

  say ""
  say "Next: bring the service up (it picks Docker or systemd; nothing is running yet):"
  say ""
  say "    $run install"
  say ""
  say "Then open http://127.0.0.1:7437"
  say ""
  if [ "$HOME_DIR" = "$HOME/.grounded" ]; then
    say "Config and runtime live in $HOME_DIR; your data will live in $HOME/Grounded/Cabinet."
  else
    say "Config, runtime and data (cabinet/) all live in $HOME_DIR."
  fi
}

main "$@"
