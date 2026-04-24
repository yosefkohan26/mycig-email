# Provisioning — MyCIG Email (staging)

Source of truth for the Cloudflare + Postgres resources the fork depends on.
The scripts here are **idempotent**; re-running them against an already-provisioned
environment should produce no changes.

## What gets provisioned

### Postgres (`01_postgres.sql`)
Lives on the MyCIG prod Postgres host (`5.78.159.244:5432`) as sibling objects to
the `production` database. Does **not** touch `production`.

| Object | Value |
|---|---|
| Role | `zero_user` (LOGIN, CREATEDB) |
| Database | `zero_email_dev` (OWNER `zero_user`) |

### Cloudflare (`02_cloudflare.sh`)
Account: `Yosef@ciglaw.com's Account` (`f16b26006e3b98faf53abfdbf1790e0e`).

| Kind | Name |
|---|---|
| R2 bucket | `mycig-email-threads-staging` |
| Vectorize index | `mycig-threads-staging` (1024 / cosine) |
| Vectorize index | `mycig-messages-staging` (1024 / cosine) |
| KV namespace × 10 | `<name>_staging` — see `KV_NAMES` in the script |
| Queue | `thread-queue-staging` |
| Queue | `subscribe-queue-staging` |
| Queue | `send-email-queue-staging` |
| Hyperdrive | `mycig-email-hyperdrive-staging` → `zero_email_dev` |

IDs (KV namespaces, queues, Hyperdrive) are wired into
`apps/server/wrangler.jsonc` staging env.

## Running

```bash
# 1. Postgres (needs superuser; run via the server)
ssh root@5.78.159.244 \
  "sudo -u postgres psql -v zero_password=\"'$ZERO_USER_PASSWORD'\"" \
  < scripts/provision/01_postgres.sql

# 2. Cloudflare
export CLOUDFLARE_API_KEY=...       # scoped token preferred; Global Key accepted
export CLOUDFLARE_EMAIL=yosef@ciglaw.com
export CLOUDFLARE_ACCOUNT_ID=f16b26006e3b98faf53abfdbf1790e0e
export ZERO_USER_PASSWORD=...       # must match what 01_postgres.sql set
./scripts/provision/02_cloudflare.sh
```

## Rotating `zero_user` password

1. On the Postgres host:
   ```sql
   ALTER ROLE zero_user PASSWORD '<new>';
   ```
2. Update Hyperdrive connection string:
   ```bash
   wrangler hyperdrive update <hyperdrive-id> \
     --connection-string="postgresql://zero_user:<url-encoded-new>@5.78.159.244:5432/zero_email_dev"
   ```
3. Rotate `ZERO_USER_PASSWORD` wherever it's stored (1Password, local `.env`, CI).

## Production

This directory only covers **staging**. Production provisioning will live in
sibling scripts (`01_postgres_prod.sql`, `02_cloudflare_prod.sh`) created at
Phase 6 cutover.
