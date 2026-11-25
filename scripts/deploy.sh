#!/usr/bin/env bash
set -euo pipefail

# One-command production redeploy for may-be.gay.
# Usage:
#   ./scripts/deploy.sh                  # Fetch and deploy origin/main
#   ./scripts/deploy.sh --ref HEAD       # Deploy current local commit
#   ./scripts/deploy.sh --with-caddy     # Also rebuild & restart Caddy
#   ./scripts/deploy.sh --skip-backup    # Skip pre-deploy encrypted snapshot
#   ./scripts/deploy.sh --dry-run        # Show what would be deployed
#
# Note: This script is tailored to the may-be.gay production server (SSH user
# `deploy`, `/opt/may-be-gay`, Bitwarden `bws-agent` fallback, and
# `https://app.may-be.gay/api/health`). Self-hosters should adjust it for their own server.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

REF="origin/main"
FETCH_ORIGIN=true
WITH_CADDY=false
SKIP_BACKUP=false
DRY_RUN=false
SSH_KEY="${MBG_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_USER="${MBG_SSH_USER:-deploy}"
REMOTE_DIR="/opt/may-be-gay"
BWS_AGENT="${BWS_AGENT:-$HOME/.local/bin/bws-agent}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      REF="${2:?--ref requires a git ref}"
      FETCH_ORIGIN=false
      shift 2
      ;;
    --with-caddy)
      WITH_CADDY=true
      shift
      ;;
    --skip-backup)
      SKIP_BACKUP=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      sed -n '3,10p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$FETCH_ORIGIN" == true ]]; then
  echo "==> Fetching origin/main..."
  git fetch origin main --quiet
fi

COMMIT_SHA="$(git rev-parse --short "$REF")"
COMMIT_SUBJECT="$(git log -1 --format=%s "$REF")"

BUILD_SERVICES=(migrate app worker)
UP_SERVICES=(app worker)
if [[ "$WITH_CADDY" == true ]]; then
  BUILD_SERVICES+=(caddy)
  UP_SERVICES+=(caddy)
fi

echo "==> Target ref: ${REF} (${COMMIT_SHA} — ${COMMIT_SUBJECT})"
echo "==> Services to rebuild: ${BUILD_SERVICES[*]}"
echo "==> Pre-deploy backup: $([[ "$SKIP_BACKUP" == true ]] && echo skipped || echo enabled)"

if [[ "$DRY_RUN" == true ]]; then
  echo "==> Dry run complete; no changes made."
  exit 0
fi

deploy_with_ip() {
  local server_ip="${MBG_SERVER_IP:?MBG_SERVER_IP not set}"
  local ssh_opts=(-i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10)

  if [[ "$SKIP_BACKUP" == false ]]; then
    echo "==> 1/5 Taking pre-deploy encrypted snapshot on VPS..."
    ssh "${ssh_opts[@]}" "${SSH_USER}@${server_ip}" \
      "cd ${REMOTE_DIR} && docker compose -f compose.prod.yaml --env-file .env.production exec -T worker node --conditions=react-server --import tsx scripts/backup.ts"
  else
    echo "==> 1/5 Skipping pre-deploy backup (--skip-backup)."
  fi

  echo "==> 2/5 Syncing ${COMMIT_SHA} to ${REMOTE_DIR}..."
  git archive --format=tar "$REF" | ssh "${ssh_opts[@]}" "${SSH_USER}@${server_ip}" "tar -xf - -C ${REMOTE_DIR}"

  echo "==> 3/5 Building images (${BUILD_SERVICES[*]})..."
  ssh "${ssh_opts[@]}" "${SSH_USER}@${server_ip}" \
    "cd ${REMOTE_DIR} && docker compose -f compose.prod.yaml --env-file .env.production build ${BUILD_SERVICES[*]}"

  echo "==> 4/5 Running database migrations and waiting for services..."
  local compose="docker compose -f compose.prod.yaml --env-file .env.production"
  if ! ssh "${ssh_opts[@]}" "${SSH_USER}@${server_ip}" "cd ${REMOTE_DIR} && ${compose} run -T --rm migrate"; then
    echo "Error: database migration failed." >&2
    return 1
  fi
  if ! ssh "${ssh_opts[@]}" "${SSH_USER}@${server_ip}" \
    "cd ${REMOTE_DIR} && ${compose} up -d --no-build --wait --wait-timeout 120 ${UP_SERVICES[*]}"; then
    echo "Error: deployment services did not become ready." >&2
    ssh "${ssh_opts[@]}" "${SSH_USER}@${server_ip}" "cd ${REMOTE_DIR} && ${compose} ps -a" || true
    return 1
  fi

  echo "==> 5/5 Verifying health..."
  if ! ssh "${ssh_opts[@]}" "${SSH_USER}@${server_ip}" \
    "cd ${REMOTE_DIR} && ${compose} exec -T worker node --conditions=react-server --import tsx scripts/check-operations.ts"; then
    echo "Error: worker operations check failed." >&2
    return 1
  fi

  local health_code
  if ! health_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://app.may-be.gay/api/health)" || [[ "$health_code" != 200 ]]; then
    echo "Error: public health check failed (HTTP ${health_code:-unavailable})." >&2
    return 1
  fi
  echo "==> https://app.may-be.gay/api/health -> HTTP ${health_code}"
  echo "==> Deployed ${COMMIT_SHA} successfully!"
}

if [[ -n "${MBG_SERVER_IP:-}" ]]; then
  deploy_with_ip
else
  if [[ ! -x "$BWS_AGENT" ]]; then
    echo "Error: MBG_SERVER_IP is unset and ${BWS_AGENT} is not executable." >&2
    exit 1
  fi
  SECRET_ID="$("$BWS_AGENT" list | jq -r '.[] | select(.key == "MBG-PROD-SERVER") | .id' | head -n1)"
  if [[ -z "$SECRET_ID" ]]; then
    echo "Error: Could not find MBG-PROD-SERVER in Bitwarden." >&2
    exit 1
  fi
  export -f deploy_with_ip
  export REF COMMIT_SHA SSH_KEY SSH_USER REMOTE_DIR SKIP_BACKUP WITH_CADDY
  export BUILD_SERVICES_STR="${BUILD_SERVICES[*]}"
  export UP_SERVICES_STR="${UP_SERVICES[*]}"
  exec "$BWS_AGENT" run --secret "$SECRET_ID" MBG_SERVER_IP -- bash -c '
    set -euo pipefail
    read -ra BUILD_SERVICES <<< "$BUILD_SERVICES_STR"
    read -ra UP_SERVICES <<< "$UP_SERVICES_STR"
    deploy_with_ip
  '
fi
