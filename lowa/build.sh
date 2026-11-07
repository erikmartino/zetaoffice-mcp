#!/usr/bin/env bash
#
# Build headless LibreOffice WASM with proxied POSIX sockets, plus the host-side
# websocket_to_posix_proxy. See README.md for the (large) resource requirements.
#
# Env overrides:
#   LOWA_DIR            build root (default: ~/lowa-build)
#   EMSDK_VERSION       emscripten version (default: 3.1.65)
#   EMSCRIPTEN_REPO     patched emscripten repo (default: allotropia/emscripten)
#   EMSCRIPTEN_BRANCH   branch (default: fixed-3.1.65)
#   APPLY_STBERGMANN    1 to cherry-pick the open socket-fix branches
#   LO_REPO / LO_BRANCH LibreOffice core repo/branch
#   LOWA_MODULES        --with-wasm-module value (default: writer)
#   JOBS                parallelism (default: nproc)
#
set -euo pipefail

ROOT="${LOWA_DIR:-$HOME/lowa-build}"
EMSDK_VERSION="${EMSDK_VERSION:-3.1.65}"
EMSCRIPTEN_REPO="${EMSCRIPTEN_REPO:-https://github.com/allotropia/emscripten.git}"
EMSCRIPTEN_BRANCH="${EMSCRIPTEN_BRANCH:-fixed-3.1.65}"
APPLY_STBERGMANN="${APPLY_STBERGMANN:-0}"
LO_REPO="${LO_REPO:-https://git.libreoffice.org/core}"
LO_BRANCH="${LO_BRANCH:-distro/allotropia/zeta-24-2}"
LOWA_MODULES="${LOWA_MODULES:-writer}"
JOBS="${JOBS:-$(nproc)}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

check_resources() {
  local free_gb mem_gb
  free_gb=$(df -BG --output=avail "$ROOT" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)
  mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
  log "Resources: ${free_gb}G free disk, ${mem_gb}G RAM"
  if [ "${free_gb:-0}" -lt 60 ]; then
    echo "WARNING: <60G free disk under $ROOT; the build will likely run out of space." >&2
  fi
  if [ "${mem_gb:-0}" -lt 32 ]; then
    echo "WARNING: <32G RAM; linking may OOM. Increase swap or use a larger machine/CI." >&2
  fi
}

build_emsdk() {
  mkdir -p "$ROOT"
  cd "$ROOT"
  if [ ! -d emsdk ]; then
    log "Cloning emsdk"
    git clone https://github.com/emscripten-core/emsdk.git
  fi
  cd emsdk
  log "Installing emscripten $EMSDK_VERSION"
  ./emsdk install "$EMSDK_VERSION"
  ./emsdk activate "$EMSDK_VERSION"
  # shellcheck disable=SC1091
  source ./emsdk_env.sh

  log "Replacing emscripten with patched fork ($EMSCRIPTEN_REPO @ $EMSCRIPTEN_BRANCH)"
  rm -rf upstream/emscripten
  git clone --depth 1 -b "$EMSCRIPTEN_BRANCH" "$EMSCRIPTEN_REPO" upstream/emscripten

  if [ "$APPLY_STBERGMANN" = "1" ]; then
    log "Applying stbergmann socket fixes"
    cd upstream/emscripten
    git remote add stbergmann https://github.com/stbergmann/emscripten.git || true
    git fetch --depth 1 stbergmann websocket-getsockopt websocket-getsockname websocket-poll
    git cherry-pick FETCH_HEAD || true
    cd ../..
  fi

  log "Building websocket_to_posix_proxy"
  g++ "upstream/emscripten/tools/websocket_to_posix_proxy/src/"*.c \
      "upstream/emscripten/tools/websocket_to_posix_proxy/src/"*.cpp \
      -o "$ROOT/websocket_to_posix_proxy" -pthread
  echo "proxy: $ROOT/websocket_to_posix_proxy"
}

build_lowa() {
  cd "$ROOT"
  if [ ! -d core ]; then
    log "Cloning LibreOffice core ($LO_BRANCH) — this is large"
    git clone --depth 1 -b "$LO_BRANCH" "$LO_REPO" core
  fi
  cd core
  log "Writing autogen.input (headless + proxied posix sockets)"
  cat > autogen.input <<EOF
--disable-debug
--disable-crashdump
--host=wasm32-local-emscripten
--disable-gui
--enable-emscripten-proxy-posix-sockets
--with-wasm-module=${LOWA_MODULES}
--with-package-format=emscripten
--without-java
--disable-odk
EOF
  log "Configuring (emconfigure)"
  ./autogen.sh
  log "Building with make -j$JOBS (this takes hours)"
  make -j"$JOBS"
  echo
  echo "Artifacts: $ROOT/core/workdir/installation/LibreOffice/emscripten"
}

check_resources
build_emsdk
build_lowa

log "Done"
cat <<EOF

Next steps:
  1. Run the host proxy:   $ROOT/websocket_to_posix_proxy 6932
  2. Serve/serve_after:    the emscripten/ output with COOP/COEP headers
  3. Set before soffice.js:
       Module.uno_websocket_to_posix_socket_url = 'ws://127.0.0.1:6932'
  4. In UNO: Acceptor.create(ctx).accept('socket,host=0.0.0.0,port=2002')
     then BridgeFactory.createBridge('', 'urp', conn, ctx)

EOF
