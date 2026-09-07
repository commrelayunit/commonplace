#!/usr/bin/env sh
set -eu

MODE=docker
REPO_URL=${REPO_URL:-https://github.com/commrelayunit/commonplace.git}
BRANCH=${BRANCH:-main}
INSTALL_DIR=${INSTALL_DIR:-"$HOME/commonplace"}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE=${2:?missing mode}; shift 2 ;;
    --directory) INSTALL_DIR=${2:?missing directory}; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in docker|lxc) ;; *) echo "--mode must be docker or lxc" >&2; exit 2 ;; esac

if [ -e "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
[ -f .env ] || cp .env.example .env

if [ "$MODE" = docker ]; then
  command -v docker >/dev/null || { echo "Docker is required for --mode docker." >&2; exit 1; }
  docker compose up -d --build
  echo "Commonplace is running on http://127.0.0.1:${COMMONPLACE_PORT:-4173}"
  exit 0
fi

command -v node >/dev/null || { echo "Node 22.5+ is required in the LXC." >&2; exit 1; }
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)" || { echo "Node 22.5+ is required in the LXC." >&2; exit 1; }
npm ci --omit=dev
mkdir -p data
echo "Installed for an LXC at $INSTALL_DIR. Start it with: cd $INSTALL_DIR && npm start"
