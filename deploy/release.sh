#!/usr/bin/env bash
# Ship a new version: verify, bump, push, publish, tag.
#
# This is what publish.yml would have done on GitHub, done locally instead,
# because Actions is disabled on this account. One command, same result.
#
#   ./deploy/release.sh patch    1.0.0 -> 1.0.1   a fix
#   ./deploy/release.sh minor    1.0.0 -> 1.1.0   new tools
#   ./deploy/release.sh major    1.0.0 -> 2.0.0   a breaking change
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BUMP="${1:-patch}"
step() { printf "\n\033[1m→ %s\033[0m\n" "$1"; }

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash first." >&2
  exit 1
fi

step "verify"
npm run typecheck
npm run build
npm test

step "bump ($BUMP)"
# Creates the commit and the git tag in one step.
NEW=$(npm version "$BUMP" -m "Release v%s")
echo "  $NEW"

step "publish to npm"
npm publish --access public

step "push to github, with the tag"
git push origin main --follow-tags

printf "\n\033[32m✓ %s is live\033[0m\n" "$NEW"
echo "  npm:    https://www.npmjs.com/package/@thenavidm/apple-podcasts-mcp"
echo "  github: https://github.com/navidmoazzez/apple-podcasts-mcp"
echo
echo "Anyone running npx picks it up automatically on their next start,"
echo "because the install line pins @latest rather than a version."
