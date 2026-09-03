#!/usr/bin/env bash
# Deploy the backend container to a self-hosted VPS.
#
# Pulls a published image from GHCR — no local build or JDK needed. Assumes
# docker-compose.prod.yml and .env are already in $COMPOSE_DIR on the server.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$SCRIPT_DIR/deploy.env" ]; then
  echo "✗ Missing deploy/deploy.env. Copy deploy/deploy.env.example and fill it in." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$SCRIPT_DIR/deploy.env"

: "${SERVER:?SERVER must be set in deploy/deploy.env}"
: "${DOMAIN:?DOMAIN must be set in deploy/deploy.env}"
: "${COMPOSE_DIR:?COMPOSE_DIR must be set in deploy/deploy.env}"
: "${API_REPO:?API_REPO must be set in deploy/deploy.env}"

# Resolve the version to ship: explicit pin wins, otherwise latest release.
# Parsed with sed rather than jq to avoid a dependency Git for Windows lacks.
if [ -n "${BE_IMAGE_TAG:-}" ]; then
  VERSION="$BE_IMAGE_TAG"
  echo "Using pinned backend version: $VERSION"
else
  echo "Resolving latest release of $API_REPO ..."
  VERSION="$(curl -sf "https://api.github.com/repos/$API_REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1 || true)"
  if [ -z "$VERSION" ]; then
    echo "✗ Could not resolve a published release. Set BE_IMAGE_TAG to pin a version." >&2
    exit 1
  fi
  echo "Latest release: $VERSION"
fi

ssh "$SERVER" bash -s "$VERSION" "$COMPOSE_DIR" <<'REMOTE'
set -euo pipefail
VERSION="$1"
COMPOSE_DIR="$2"
COMPOSE_FILE="docker-compose.prod.yml"

cd "$COMPOSE_DIR"

if [ ! -f .env ]; then
  echo "✗ $COMPOSE_DIR/.env is missing. Create it from deploy/api.env.example." >&2
  exit 1
fi

export BE_IMAGE_TAG="$VERSION"

echo "Pulling image..."
docker compose -f "$COMPOSE_FILE" pull --quiet api

echo "Starting api..."
docker compose -f "$COMPOSE_FILE" up -d api

docker image prune -f >/dev/null

echo "Waiting for health..."
for _ in $(seq 1 20); do
  STATUS="$(docker compose -f "$COMPOSE_FILE" ps api --format '{{.Health}}' 2>/dev/null || echo unknown)"
  if [ "$STATUS" = "healthy" ]; then
    echo "Container healthy"
    exit 0
  fi
  sleep 3
done

echo "✗ Container did not become healthy. Recent logs:" >&2
docker compose -f "$COMPOSE_FILE" logs --tail 40 api >&2
exit 1
REMOTE

echo "Verifying through nginx..."
API_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/health")"
if [ "$API_STATUS" != "200" ]; then
  echo "✗ https://$DOMAIN/api/health returned $API_STATUS" >&2
  exit 1
fi

# The API must never be reachable except through nginx. A success here means
# the port mapping lost its 127.0.0.1 prefix and the API is exposed over
# plain HTTP on the public interface.
HOST_ONLY="${SERVER#*@}"
if curl -sf --max-time 5 "http://$HOST_ONLY:8080/api/health" >/dev/null 2>&1; then
  echo "✗ SECURITY: API answered on public port 8080. Fix the ports mapping to 127.0.0.1:8080:8080." >&2
  exit 1
fi

echo "✓ Backend $VERSION is live at https://$DOMAIN/api"
