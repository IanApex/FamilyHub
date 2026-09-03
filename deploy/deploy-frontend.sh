#!/usr/bin/env bash
# Build and ship the frontend to a self-hosted VPS.
#
# Self-host counterpart to the upstream ./deploy.sh, which is hardcoded to
# joe-bor's droplet. Reads targets from deploy/deploy.env.
#
# Uploads with tar-over-ssh rather than rsync, because Git for Windows ships
# bash and curl but not rsync.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$SCRIPT_DIR/deploy.env" ]; then
  echo "✗ Missing deploy/deploy.env. Copy deploy/deploy.env.example and fill it in." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$SCRIPT_DIR/deploy.env"

: "${SERVER:?SERVER must be set in deploy/deploy.env}"
: "${DOMAIN:?DOMAIN must be set in deploy/deploy.env}"
: "${FE_REMOTE_PATH:?FE_REMOTE_PATH must be set in deploy/deploy.env}"

cd "$REPO_ROOT"

VERSION="$(node -p "require('./package.json').version")"
RELEASE_TAG="family-hub-v$VERSION"

# === PRE-DEPLOY CHECKS (fastest → slowest) ===

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is dirty. Commit or stash first." >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  echo "✗ Must deploy from main (currently on '$BRANCH')." >&2
  exit 1
fi

git fetch origin main --quiet
git fetch origin --tags --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "✗ Local main is not in sync with origin/main." >&2
  exit 1
fi

if ! git rev-parse -q --verify "refs/tags/$RELEASE_TAG" >/dev/null; then
  echo "✗ Release tag '$RELEASE_TAG' does not exist. Cut the release first." >&2
  exit 1
fi

if [ "$(git rev-parse HEAD)" != "$(git rev-list -n 1 "$RELEASE_TAG")" ]; then
  echo "✗ HEAD is not the released commit for $RELEASE_TAG." >&2
  echo "  Ship released commits only, not arbitrary main." >&2
  exit 1
fi

echo "Running lint..."
npm run lint

echo "Running tests..."
npm test -- --run

# === BUILD & UPLOAD ===

echo "Building $RELEASE_TAG..."
npm run build

echo "Uploading to $SERVER:$FE_REMOTE_PATH ..."
tar -czf - -C dist . | ssh "$SERVER" bash -s "$FE_REMOTE_PATH" <<'REMOTE'
set -euo pipefail
TARGET="$1"

# Stage then swap, so a failed upload never leaves a half-written site served.
rm -rf "$TARGET.new" "$TARGET.old"
mkdir -p "$TARGET.new"
tar -xzf - -C "$TARGET.new"
chmod -R a+rX "$TARGET.new"

if [ -d "$TARGET" ]; then
  mv "$TARGET" "$TARGET.old"
fi
mv "$TARGET.new" "$TARGET"
rm -rf "$TARGET.old"
REMOTE

echo "Verifying..."
sleep 2

SITE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/")"
API_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/health")"

if [ "$SITE_STATUS" = "200" ] && [ "$API_STATUS" = "200" ]; then
  echo "✓ $RELEASE_TAG is live at https://$DOMAIN"
else
  echo "✗ Post-deploy check failed (site=$SITE_STATUS api=$API_STATUS)" >&2
  exit 1
fi
