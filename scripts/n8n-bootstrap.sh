#!/usr/bin/env bash
# Idempotent n8n bootstrap: owner account, credentials, workflows, publish, restart.
# Usage: scripts/n8n-bootstrap.sh [compose-file]   (default: docker-compose.yml)
# Secrets are read from the running stack / .env and piped over stdin into a temp
# file inside the n8n container. They are never written to the repo or printed.
set -euo pipefail

export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'   # Git Bash: don't rewrite /tmp, /workflows

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${1:-$ROOT/docker-compose.yml}"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
n8n_exec() { dc exec -T n8n "$@"; }
n8n_cli() { n8n_exec n8n "$@" 2> >(grep -v 'license SDK' >&2) | grep -v 'license SDK' || true; }

OWNER_EMAIL="${N8N_OWNER_EMAIL:-owner@jobhunter.local}"
OWNER_PASSWORD="${N8N_OWNER_PASSWORD:-Jobhunter-Local-1}"

wait_healthy() {
  local i
  for i in $(seq 1 90); do
    if n8n_exec node -e "fetch('http://localhost:5678/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "n8n did not become healthy" >&2
  return 1
}

# Read KEY from .env without sourcing it.
env_value() {
  [ -f "$ROOT/.env" ] || return 0
  grep -E "^$1=" "$ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '\r' || true
}

echo "[bootstrap] waiting for n8n"
wait_healthy

# 1. Owner account (n8n 2.x needs an owner to own imported credentials/workflows).
#    Re-running returns 4xx once the owner exists; that is fine.
echo "[bootstrap] ensuring owner account"
N8N_OWNER_EMAIL="$OWNER_EMAIL" N8N_OWNER_PASSWORD="$OWNER_PASSWORD" \
  n8n_exec sh -c 'cat >/tmp/owner.json' <<JSON
{"email":"$OWNER_EMAIL","password":"$OWNER_PASSWORD","firstName":"Job","lastName":"Hunter"}
JSON
n8n_exec node -e "
const b=require('fs').readFileSync('/tmp/owner.json','utf8');
fetch('http://localhost:5678/rest/owner/setup',{method:'POST',headers:{'content-type':'application/json'},body:b})
 .then(r=>console.log('owner setup status',r.status)).finally(()=>require('fs').unlinkSync('/tmp/owner.json'));"

# 2. Credentials (ids are fixed, so import upserts rather than duplicates).
echo "[bootstrap] importing credentials"
PG_PASSWORD="$(dc exec -T postgres printenv POSTGRES_PASSWORD | tr -d '\r\n')"
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-$(env_value ANTHROPIC_API_KEY)}"
if [ -z "$ANTHROPIC_KEY" ]; then
  case "$COMPOSE_FILE" in
    *test*) ANTHROPIC_KEY="test-dummy-key" ;;  # the stub only checks the header exists
    *) echo "ANTHROPIC_API_KEY is empty in .env" >&2; exit 1 ;;
  esac
fi
PG_PASSWORD="$PG_PASSWORD" ANTHROPIC_KEY="$ANTHROPIC_KEY" node -e '
const e = process.env;
process.stdout.write(JSON.stringify([
  { id: "jh-postgres", name: "JobHunter Postgres", type: "postgres",
    data: { host: "postgres", port: 5432, database: "jobhunter", user: "jobhunter", password: e.PG_PASSWORD, ssl: "disable" } },
  { id: "jh-anthropic", name: "Anthropic", type: "anthropicApi", data: { apiKey: e.ANTHROPIC_KEY } },
]));' | n8n_exec sh -c 'umask 077; cat >/tmp/jh-credentials.json'
n8n_cli import:credentials --input=/tmp/jh-credentials.json
n8n_exec rm -f /tmp/jh-credentials.json

# 3. Workflows. --activeState defaults to false, so everything is imported inactive and
#    published explicitly below. Workflow JSON must carry stable ids to stay idempotent.
echo "[bootstrap] importing workflows"
n8n_cli import:workflow --separate --input=/workflows

# 4. Publish all workflows (n8n 2.x: publish:workflow; takes effect only after restart).
echo "[bootstrap] publishing workflows"
IDS="$(n8n_exec n8n list:workflow --onlyId 2>/dev/null | grep -v 'license SDK' | tr -d '\r' || true)"
for id in $IDS; do
  n8n_cli publish:workflow --id="$id"
done

if [ -n "$IDS" ]; then
  echo "[bootstrap] restarting n8n to register published workflows"
  SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  dc restart n8n >/dev/null
  wait_healthy
  for _ in $(seq 1 60); do
    dc logs --since "$SINCE" n8n 2>/dev/null | grep -q 'Finished building workflow dependency index' && break
    sleep 1
  done
fi
echo "[bootstrap] done"
