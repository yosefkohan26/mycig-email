#!/usr/bin/env bash
# Provisions Cloudflare resources for MyCIG Email (the Zero fork).
# Idempotent: existing resources are left alone; new ones are created.
#
# Prereqs:
#   - wrangler >= 4.85 in PATH
#   - CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL + CLOUDFLARE_ACCOUNT_ID in env
#     (Global API Key is accepted; a scoped token is preferred.)
#
# Run from anywhere:
#   ./02_cloudflare.sh
#
# State produced (must match apps/server/wrangler.jsonc staging env):
#   R2 bucket        mycig-email-threads-staging
#   Vectorize index  mycig-threads-staging   (1024 / cosine)
#   Vectorize index  mycig-messages-staging  (1024 / cosine)
#   KV namespaces    <10 names>_staging      (see array below)
#   Queues           thread-queue-staging / subscribe-queue-staging / send-email-queue-staging
#   Hyperdrive       mycig-email-hyperdrive-staging (binding to zero_email_dev)

set -euo pipefail

: "${CLOUDFLARE_API_KEY:?Set CLOUDFLARE_API_KEY}"
: "${CLOUDFLARE_EMAIL:?Set CLOUDFLARE_EMAIL}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"

# Postgres connection for Hyperdrive. Password must already be set in Postgres
# (via 01_postgres.sql). We read it from env so it's never committed.
: "${ZERO_USER_PASSWORD:?Set ZERO_USER_PASSWORD (matches what 01_postgres.sql set)}"
PG_HOST="${PG_HOST:-5.78.159.244}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-zero_email_dev}"
PG_USER="${PG_USER:-zero_user}"

say() { printf '\n==> %s\n' "$*"; }
skip() { printf '    skip: %s\n' "$*"; }
make() { printf '    make: %s\n' "$*"; }

# --- R2 bucket ----------------------------------------------------------------
say "R2 bucket: mycig-email-threads-staging"
if wrangler r2 bucket list 2>/dev/null | grep -q '^name: *mycig-email-threads-staging'; then
  skip "already exists"
else
  make "creating"
  wrangler r2 bucket create mycig-email-threads-staging
fi

# --- Vectorize indexes --------------------------------------------------------
create_vectorize() {
  local name="$1"
  say "Vectorize: $name"
  if wrangler vectorize list 2>/dev/null | grep -q "│ $name "; then
    skip "already exists"
  else
    make "creating (1024 / cosine)"
    wrangler vectorize create "$name" --dimensions=1024 --metric=cosine
  fi
}
create_vectorize mycig-threads-staging
create_vectorize mycig-messages-staging

# --- KV namespaces ------------------------------------------------------------
KV_NAMES=(
  gmail_history_id
  gmail_processing_threads
  subscribed_accounts
  connection_labels
  prompts_storage
  gmail_sub_age
  pending_emails_status
  pending_emails_payload
  scheduled_emails
  snoozed_emails
)
existing_kv_json="$(wrangler kv namespace list 2>/dev/null || echo '[]')"
for base in "${KV_NAMES[@]}"; do
  title="${base}_staging"
  say "KV: $title"
  if echo "$existing_kv_json" | grep -q "\"title\": \"$title\""; then
    skip "already exists"
  else
    make "creating"
    wrangler kv namespace create "$title"
  fi
done

# --- Queues -------------------------------------------------------------------
QUEUES=(thread-queue-staging subscribe-queue-staging send-email-queue-staging)
existing_queues="$(wrangler queues list 2>/dev/null || true)"
for q in "${QUEUES[@]}"; do
  say "Queue: $q"
  if echo "$existing_queues" | grep -q "│ $q "; then
    skip "already exists"
  else
    make "creating"
    wrangler queues create "$q"
  fi
done

# --- Hyperdrive ---------------------------------------------------------------
say "Hyperdrive: mycig-email-hyperdrive-staging"
if wrangler hyperdrive list 2>/dev/null | grep -q 'mycig-email-hyperdrive-staging'; then
  skip "already exists (update connection string with: wrangler hyperdrive update <id> --connection-string=...)"
else
  make "creating"
  # URL-encode the password so special chars don't break the connection string
  PW_ENCODED="$(printf '%s' "$ZERO_USER_PASSWORD" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')"
  wrangler hyperdrive create mycig-email-hyperdrive-staging \
    --connection-string="postgresql://${PG_USER}:${PW_ENCODED}@${PG_HOST}:${PG_PORT}/${PG_DB}"
fi

say "Done."
