#!/usr/bin/env bash
# Are GitHub and npm showing the same thing?
#
# They drift silently, because they update on different events. GitHub updates
# on every push. npm updates only when a version is published, and that includes
# the README: editing docs and pushing leaves npm showing the old text forever.
#
# This says whether they match, and what to run if they do not.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PKG=$(node -p "require('./package.json').name")
LOCAL_V=$(node -p "require('./package.json').version")
NPM_V=$(npm view "$PKG" version 2>/dev/null || echo "not published")

echo "package     $PKG"
echo "local       $LOCAL_V"
echo "npm         $NPM_V"

drift=0

if [ "$LOCAL_V" != "$NPM_V" ]; then
  echo "→ version drift: local is $LOCAL_V, npm has $NPM_V"
  drift=1
fi

# npm serves the README from the published tarball, so comparing it to the
# working copy is the only honest check of what a visitor actually reads.
tmp=$(mktemp -d)
if npm view "$PKG" readme > "$tmp/npm-readme.md" 2>/dev/null && [ -s "$tmp/npm-readme.md" ]; then
  if ! diff -q <(sed -e 's/[[:space:]]*$//' README.md) \
                <(sed -e 's/[[:space:]]*$//' "$tmp/npm-readme.md") >/dev/null 2>&1; then
    lines=$(diff <(cat README.md) <(cat "$tmp/npm-readme.md") | grep -c '^[<>]' || true)
    echo "→ README drift: $lines line(s) differ between this repo and the npm page"
    drift=1
  fi
fi
rm -rf "$tmp"

if [ -n "$(git status --porcelain)" ]; then
  echo "→ uncommitted changes in the working tree"
  drift=1
fi

ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
[ "$ahead" != "0" ] && { echo "→ $ahead commit(s) not pushed to GitHub"; drift=1; }

echo
if [ "$drift" = "0" ]; then
  echo "✓ GitHub and npm are showing the same thing"
else
  echo "✗ out of sync. Run ./deploy/release.sh patch to publish and push together."
  exit 1
fi
