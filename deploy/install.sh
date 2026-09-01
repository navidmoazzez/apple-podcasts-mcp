#!/usr/bin/env bash
# Install apple-podcasts-mcp from source and register it with Claude Code.
#
# For the npm route, or any other client, see the README. This exists for the
# case the README cannot cover in one paste: a clone, a build, and a client
# pointed at an absolute path.
set -euo pipefail

REPO="${APPLE_PODCASTS_MCP_REPO:-https://github.com/navidmoazzez/apple-podcasts-mcp.git}"
DIR="${APPLE_PODCASTS_MCP_DIR:-$HOME/.local/share/apple-podcasts-mcp}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1" >&2; exit 1; }
}

need git
need node
need npm

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "Node 20 or newer is required. Found $(node -v)." >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "Cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
npm install
npm run build

echo
echo "Built at $DIR/dist/index.js"
echo

if command -v claude >/dev/null 2>&1; then
  echo "Registering with Claude Code..."
  claude mcp add apple-podcasts -- node "$DIR/dist/index.js"
else
  cat <<MSG
Point your MCP client at:

  node $DIR/dist/index.js

MSG
fi

cat <<'MSG'
No credentials are needed. Apple's catalog, charts, reviews and podcast RSS
feeds are all open, and your own library is read straight off this Mac.

On macOS, the library tools need Full Disk Access for whichever app launches
the server (your terminal, or Claude Desktop):

  System Settings > Privacy & Security > Full Disk Access

Add it, then quit and reopen that app. The permission is only read at launch.

MSG

echo "Checking the setup..."
node "$DIR/dist/index.js" doctor
