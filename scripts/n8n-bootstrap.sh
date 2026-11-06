#!/usr/bin/env bash
# Idempotent n8n bootstrap: owner account, credentials, workflows, publish, restart.
# Usage: scripts/n8n-bootstrap.sh [compose-file]   (default: docker-compose.yml)
#        JOBHUNTER_ENV_FILE overrides the env file (default: <repo>/.env).
# Sourcing the script (`. scripts/n8n-bootstrap.sh`) only defines settings and functions;
# nothing runs and no container is touched (used by tests/e2e/bootstrap.e2e.test.ts).
# Secrets are read from the running stack / .env and piped over stdin into the n8n
# container. They are never written to the repo or printed.
set -euo pipefail

export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'   # Git Bash: don't rewrite /tmp, /workflows

# Paths go to Windows docker/node as well as bash. With path conversion off, a Git Bash
# path like /c/... is unreadable to them, so use the mixed form C:/... (pwd -W) on
# Windows; bash accepts it too. Elsewhere pwd -W fails and plain pwd is used.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && { pwd -W 2>/dev/null || pwd; })"
to_native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m -- "$1"; else printf '%s\n' "$1"; fi; }
COMPOSE_FILE="$(to_native_path "${1:-$ROOT/docker-compose.yml}")"
IS_TEST_STACK=0
[ "$(basename "$COMPOSE_FILE")" = "docker-compose.test.yml" ] && IS_TEST_STACK=1
ENV_FILE="$(to_native_path "${JOBHUNTER_ENV_FILE:-$ROOT/.env}")"

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
n8n_exec() { dc exec -T n8n "$@"; }
# Run the n8n CLI, hide licence-SDK noise, but keep the real exit status.
n8n_cli() {
  local out
  if ! out="$(n8n_exec n8n "$@" 2>&1)"; then
    printf '%s\n' "$out" | grep -v 'license SDK' >&2 || true
    echo "n8n $* failed" >&2
    return 1
  fi
  printf '%s\n' "$out" | grep -v 'license SDK' || true
}

wait_healthy() {
  local i
  for i in $(seq 1 90); do
    if n8n_exec node -e "fetch('http://localhost:5678/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "n8n did not become healthy within 180s" >&2
  return 1
}

# Read KEY from .env without sourcing it. One pair of matching surrounding quotes
# (KEY="v" or KEY='v') is stripped, as docker compose does.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r' || true)"
  if [ "${#v}" -ge 2 ] && { [[ $v == \"*\" ]] || [[ $v == \'*\' ]]; }; then
    v="${v:1:${#v}-2}"
  fi
  printf '%s' "$v"
}

# Set KEY=VALUE in .env (replace an existing/empty line, else append).
set_env_value() {
  local key="$1" value="$2"
  touch "$ENV_FILE"
  if grep -qE "^$key=" "$ENV_FILE"; then
    KEY="$key" VALUE="$value" node -e '
      const fs = require("fs"), f = process.argv[1], k = process.env.KEY;
      const out = fs.readFileSync(f, "utf8").split(/\r?\n/).map((l) => (l.startsWith(k + "=") ? k + "=" + process.env.VALUE : l)).join("\n");
      fs.writeFileSync(f, out);' "$ENV_FILE"
  else
    if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then echo >>"$ENV_FILE"; fi
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

# Owner login: fixed, non-secret values for the throwaway test stack only. The real
# stack takes them from .env and generates (and saves) whatever is missing.
ensure_owner_login() {
if [ "$IS_TEST_STACK" = 1 ]; then
  OWNER_EMAIL="owner@jobhunter.local"
  OWNER_PASSWORD="Jobhunter-Local-1"
else
  OWNER_EMAIL="$(env_value N8N_OWNER_EMAIL)"
  OWNER_PASSWORD="$(env_value N8N_OWNER_PASSWORD)"
  GENERATED=0
  if [ -z "$OWNER_EMAIL" ]; then
    OWNER_EMAIL="prayush@jobhunter.local"
    set_env_value N8N_OWNER_EMAIL "$OWNER_EMAIL"
    GENERATED=1
  fi
  if [ -z "$OWNER_PASSWORD" ]; then
    # base64url chars plus a suffix that satisfies n8n's upper/lower/digit rule.
    OWNER_PASSWORD="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url") + "Aa1")')"
    set_env_value N8N_OWNER_PASSWORD "$OWNER_PASSWORD"
    GENERATED=1
  fi
  if [ "$GENERATED" = 1 ]; then echo "[bootstrap] n8n owner login saved in .env"; fi
fi
}

# Workflow ids shipped in n8n/workflows/*.json (mounted at /workflows). Only these are
# published; workflows the user created in the editor are left alone.
shipped_workflow_ids() {
  n8n_exec node -e '
const fs = require("fs");
for (const f of fs.readdirSync("/workflows").filter((f) => f.endsWith(".json")).sort()) {
  const wf = JSON.parse(fs.readFileSync("/workflows/" + f, "utf8"));
  if (!wf.id) { console.error("workflow without id: " + f); process.exit(1); }
  console.log(wf.id);
}' | tr -d '\r'
}

# n8n 2.x applies publish/unpublish through a publication outbox (table
# workflow_publication_outbox) that the running n8n polls every 15 s. Importing a published
# workflow unpublishes it and queues a record carrying the OLD version id. publish:workflow
# only sets activeVersionId (it queues nothing). If the old record is applied after that,
# n8n sees an active workflow and publishes the OLD version; while it is queued, the startup
# re-publish of the new one is skipped too. Webhooks then serve the old version, and the
# webhook probe below cannot tell versions apart.
# wait_publication drained IDS...: waits until every outbox record of IDS is processed.
# wait_publication published IDS...: also requires published version = active version =
#   current (last imported) version for every id.
# Outbox status values in n8n 2.46.6 (WorkflowPublicationOutboxStatus, checked on the test
# stack): pending -> in_progress -> completed | partial_success | failed. Processed rows
# are kept (a cleanup task deletes them after 1 h / 7 days), so any row NOT in that terminal
# set counts as in flight: an unknown status keeps the wait waiting (fails closed).
# Reads n8n's SQLite database (the n8n default; this stack sets no DB_TYPE) read-only.
# Query errors (e.g. a transient SQLITE_BUSY) are retried. Fails closed (exit 1) after
# JOBHUNTER_PUBLISH_WAIT_S seconds (a whole number >= 1, default 120; anything else exits
# 1 at once), naming the last error and the stuck row's status and age.
wait_publication() {
  local wait_s="${JOBHUNTER_PUBLISH_WAIT_S:-120}"
  if ! [[ $wait_s =~ ^[1-9][0-9]*$ ]]; then
    echo "JOBHUNTER_PUBLISH_WAIT_S must be a whole number of seconds (1 or more), got: $wait_s" >&2
    return 1
  fi
  n8n_exec node -e '
const { DatabaseSync } = require("node:sqlite");
const [mode, waitS, ...ids] = process.argv.slice(1);
if (mode !== "drained" && mode !== "published") { console.error("wait_publication: unknown mode " + mode); process.exit(2); }
if ((process.env.DB_TYPE || "sqlite") !== "sqlite") { console.error("wait_publication: only the SQLite database is supported"); process.exit(1); }
const file = (process.env.N8N_USER_FOLDER || "/home/node") + "/.n8n/database.sqlite";
const ago = (s) => (s < 90 ? Math.round(s) + "s" : s < 5400 ? Math.round(s / 60) + "m" : s < 172800 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d");
let db, detail;
const pending = (id) => {
  detail = "";
  db ??= new DatabaseSync(file, { readOnly: true });
  // Oldest unprocessed row: its status and age show e.g. a leftover from a crashed run.
  const row = db.prepare("select status, (julianday(\x27now\x27) - julianday(createdAt)) * 86400 as age from workflow_publication_outbox where workflowId = ? and status not in (\x27completed\x27, \x27partial_success\x27, \x27failed\x27) order by id limit 1").get(id);
  if (row) {
    detail = " (status " + row.status + ", queued " + (row.age == null ? "at an unknown time" : ago(Math.max(0, row.age)) + " ago") + ")";
    return "publication still queued";
  }
  if (mode !== "published") return null;
  const v = db.prepare("select w.versionId as current, w.activeVersionId as active, p.publishedVersionId as published from workflow_entity w left join workflow_published_version p on p.workflowId = w.id where w.id = ?").get(id);
  return v && v.active === v.current && v.published === v.current ? null : "published version is not the imported one";
};
(async () => {
  const deadline = Date.now() + Number(waitS) * 1000;
  for (const id of ids) {
    for (;;) {
      let why;
      try { why = pending(id); } catch (e) { why = "cannot read " + file + ": " + e.message; detail = ""; db = undefined; }
      if (!why) break;
      if (Date.now() > deadline) { console.error(id + ": " + why + " after " + waitS + "s" + detail); process.exit(1); }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
})();' "$1" "$wait_s" "${@:2}"
}

remove_temp_credentials() { n8n_exec rm -f /tmp/jh-credentials.json >/dev/null 2>&1 || true; }

# Checks $ANTHROPIC_KEY with a free request (GET /v1/models) before it is saved into n8n,
# so a wrong key stops the bootstrap instead of turning up later as failed extractions.
# Runs inside the n8n container (the same network path n8n uses). The key travels over
# stdin, never argv, and is never printed. Base URL: JOBHUNTER_ANTHROPIC_BASE_URL (the
# tests point it at the stub), else the container's ANTHROPIC_BASE_URL, else
# https://api.anthropic.com. Returns 1 with a message on any failure.
check_anthropic_key() {
  local result
  result="$(KEY="${ANTHROPIC_KEY:-}" BASE="${JOBHUNTER_ANTHROPIC_BASE_URL:-}" node -e '
process.stdout.write(JSON.stringify({ key: process.env.KEY, base: process.env.BASE }));' |
    n8n_exec node -e '
(async () => {
  let input = "";
  for await (const c of process.stdin) input += c;
  const { key, base } = JSON.parse(input);
  const url = (base || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "") + "/v1/models";
  try {
    const r = await fetch(url, { headers: { "x-api-key": key, "anthropic-version": "2026-10-21" }, signal: AbortSignal.timeout(20000) });
    console.log(r.status);
  } catch (e) {
    console.log("network " + ((e.cause && e.cause.code) || e.name || "error"));
  }
})().catch(() => console.log("error"));' | tr -d '\r')" || true
  case "$result" in
    200) echo "[bootstrap] Anthropic API key accepted" ;;
    401 | 403)
      echo "Your Anthropic API key was rejected — check ANTHROPIC_API_KEY in .env" >&2
      return 1 ;;
    network\ *)
      echo "Could not reach the Anthropic API to check the key (${result#network }). Check your internet connection and run the bootstrap again." >&2
      return 1 ;;
    [0-9][0-9][0-9])
      echo "Checking the Anthropic API key failed: GET /v1/models answered HTTP $result. Try the bootstrap again later." >&2
      return 1 ;;
    *)
      echo "Could not run the Anthropic API key check inside the n8n container." >&2
      return 1 ;;
  esac
}

# Sourced (tests): stop here, having only defined settings and functions.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi

ensure_owner_login

echo "[bootstrap] waiting for n8n"
wait_healthy

# 1. Owner account (n8n 2.x needs an owner to own imported credentials/workflows).
#    Pre-checks setup state; any failure other than "already set up" aborts.
echo "[bootstrap] ensuring owner account"
OWNER_EMAIL="$OWNER_EMAIL" OWNER_PASSWORD="$OWNER_PASSWORD" node -e '
process.stdout.write(JSON.stringify({ email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD, firstName: "Job", lastName: "Hunter" }));' |
  n8n_exec node -e '
const base = "http://localhost:5678";
(async () => {
  // /healthz can answer before the REST API serves JSON on a fresh volume: retry briefly.
  let s;
  for (let i = 0; ; i++) {
    try { s = await (await fetch(base + "/rest/settings")).json(); if (s && s.data) break; } catch (e) { if (i >= 60) throw e; }
    if (i >= 60) throw new Error("/rest/settings not ready");
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (s.data.userManagement.showSetupOnFirstLoad === false) { console.log("owner already set up"); return; }
  let body = "";
  for await (const c of process.stdin) body += c;
  const r = await fetch(base + "/rest/owner/setup", { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!r.ok) { console.error("owner setup failed: HTTP " + r.status); process.exit(1); }
  console.log("owner created");
})().catch((e) => { console.error("owner setup failed: " + e.message); process.exit(1); });
'

# 2. Credentials (ids are fixed, so import upserts rather than duplicates).
echo "[bootstrap] importing credentials"
PG_PASSWORD="$(dc exec -T postgres printenv POSTGRES_PASSWORD | tr -d '\r\n')"
if [ "$IS_TEST_STACK" = 1 ]; then
  ANTHROPIC_KEY="test-dummy-key"   # the stub only checks the header exists; never use a real key here
else
  ANTHROPIC_KEY="$(env_value ANTHROPIC_API_KEY)"
  [ -n "$ANTHROPIC_KEY" ] || { echo "ANTHROPIC_API_KEY is empty in .env" >&2; exit 1; }
  echo "[bootstrap] checking the Anthropic API key"
  check_anthropic_key || exit 1
fi
# Remove the in-container temp file holding secrets even if a step fails or is interrupted.
trap remove_temp_credentials EXIT
trap 'exit 1' INT TERM
PG_PASSWORD="$PG_PASSWORD" ANTHROPIC_KEY="$ANTHROPIC_KEY" node -e '
const e = process.env;
process.stdout.write(JSON.stringify([
  { id: "jh-postgres", name: "JobHunter Postgres", type: "postgres",
    data: { host: "postgres", port: 5432, database: "jobhunter", user: "jobhunter", password: e.PG_PASSWORD, ssl: "disable" } },
  { id: "jh-anthropic", name: "Anthropic", type: "anthropicApi", data: { apiKey: e.ANTHROPIC_KEY } },
]));' | n8n_exec sh -c 'umask 077; cat >/tmp/jh-credentials.json'
n8n_cli import:credentials --input=/tmp/jh-credentials.json
remove_temp_credentials
trap - EXIT INT TERM

# 3. Workflows. --activeState defaults to false, so everything is imported inactive and
#    published explicitly below. Workflow JSON must carry stable ids to stay idempotent.
echo "[bootstrap] importing workflows"
n8n_cli import:workflow --separate --input=/workflows
IDS="$(shipped_workflow_ids)"
# Let the running n8n apply the unpublish records the import queued (with the old version
# ids) while the workflows really are unpublished; see wait_publication.
# shellcheck disable=SC2086
wait_publication drained $IDS || { echo "[bootstrap] n8n did not process the workflow import" >&2; exit 1; }

# 4. Publish the shipped workflows only (n8n 2.x: publish:workflow; takes effect only
#    after restart). Other workflows in n8n are not touched.
echo "[bootstrap] publishing workflows"
for id in $IDS; do
  n8n_cli publish:workflow --id="$id"
done

if [ -n "$IDS" ]; then
  echo "[bootstrap] restarting n8n to register published workflows"
  dc restart n8n >/dev/null
  wait_healthy
  # The version n8n serves is the one in workflow_published_version: wait until n8n has
  # published the imported version of every shipped workflow.
  # shellcheck disable=SC2086
  wait_publication published $IDS || { echo "[bootstrap] n8n did not publish the imported workflow versions" >&2; exit 1; }
  # /healthz is up before published webhooks are registered. For every webhook node in
  # /workflows, probe with a method it does not accept: a registered path answers
  # "Did you mean to make a ... request?" (nothing is executed), an unregistered one
  # answers "is not registered". Fails closed (exit 1) on timeout.
  n8n_exec node -e '
const fs = require("fs");
const hooks = [];
for (const f of fs.readdirSync("/workflows").filter((f) => f.endsWith(".json"))) {
  const wf = JSON.parse(fs.readFileSync("/workflows/" + f, "utf8"));
  for (const n of wf.nodes || []) if (n.type === "n8n-nodes-base.webhook")
    hooks.push({ path: n.parameters.path, method: (n.parameters.httpMethod || "GET").toUpperCase() });
}
const registered = async (h) => {
  const probe = h.method === "GET" ? "POST" : "GET";
  const r = await fetch("http://localhost:5678/webhook/" + h.path, { method: probe });
  const j = await r.json().catch(() => ({}));
  return r.status !== 404 || /Did you mean/.test(j.message || "");
};
(async () => {
  const deadline = Date.now() + 120000;
  for (const h of hooks) {
    while (!(await registered(h).catch(() => false))) {
      if (Date.now() > deadline) { console.error("webhook not registered after restart: " + h.method + " " + h.path); process.exit(1); }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.log("verified " + hooks.length + " webhook(s) registered");
})();
' || { echo "[bootstrap] n8n did not register published workflows" >&2; exit 1; }
fi
echo "[bootstrap] done"
