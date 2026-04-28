# aipictors-api

Cloudflare Workers + Hono + PostgreSQL/Neon based internal API for Aipictors.

This repo centralizes internal APIs migrated out of the legacy system and now stores points/subscriptions in Neon PostgreSQL.
Current scope:

- Points ledger and balances
- Stripe point checkout
- Stripe subscription checkout
- Stripe webhook processing
- PostgreSQL-backed subscription state
- Admin pricing settings for points and subscriptions

## Main endpoints

- `GET /healthz`
- `GET /internal/points/:userId`
- `POST /internal/points/grant`
- `POST /internal/points/consume`
- `GET /internal/subscriptions/current/:userId`
- `GET /internal/subscriptions/has-previous/:userId`
- `POST /internal/subscriptions/upsert`
- `POST /internal/subscriptions/disable`
- `GET /admin/pricing`
- `PUT /admin/pricing`
- `POST /stripe/checkout/points`
- `POST /stripe/checkout/subscription`
- `POST /webhooks/stripe`

## Auth model

- Internal APIs use `Authorization: Bearer <INTERNAL_API_TOKEN>`
- Admin APIs use `Authorization: Bearer <ADMIN_API_TOKEN>`
- Stripe webhook uses Stripe signature verification

## PostgreSQL / Neon setup

Neon project:

- Project ID: `lucky-bonus-09897233`
- Project name: `Aipictors`

1. Create the Neon database or use the existing project above.
2. Apply `sql/schema.sql` to PostgreSQL.
3. Set the connection string as a Workers secret:

```bash
printf '%s' "$DATABASE_URL" | npx wrangler secret put DATABASE_URL
```

Local example:

```bash
npx neonctl@latest init
psql "$DATABASE_URL" -f sql/schema.sql
```

## Deployment (`backend.aipictors.com`)

`wrangler.toml` does **not** declare `routes` on purpose: `wrangler deploy` then only updates the Worker script and secrets/vars (account-scoped APIs). **Custom hostnames are maintained in the Cloudflare Dashboard**, so GitHub Actions can use a narrow token (Workers Scripts) without **Zone → Workers Routes** and without hitting `Authentication error [code: 10000]` on `/zones/.../workers/routes`.

### Custom routes (dashboard)

In [Workers & Pages](https://dash.cloudflare.com/) → **aipictors-api** → **Settings** → **Domains & Routes** (or **Triggers**), ensure the Worker is attached to zone **`aipictors.com`** with at least:

| Route pattern |
| --- |
| `backend.aipictors.com/healthz` |
| `backend.aipictors.com/internal/*` |
| `backend.aipictors.com/admin/*` |
| `backend.aipictors.com/stripe/*` |
| `backend.aipictors.com/webhooks/stripe` |

If these already existed from an earlier Wrangler deploy, you do not need to recreate them. When you add or change hostnames, do it here (or via Terraform), not in `wrangler.toml`, unless you intentionally want Wrangler to manage routes again (then the deploy token needs zone Workers Routes permission).

`workers_dev` is **false** so the Worker is not served on `*.workers.dev`; traffic is only via the routes above.

### Required API token scopes (CI / `CLOUDFLARE_API_TOKEN`)

**Account** (include this Cloudflare account):

- Workers Scripts — Edit  
- (Optional) Workers KV Storage — Edit  
- (Optional) Workers Tail — Read  

No zone resources are required for `npx wrangler deploy` with the current `wrangler.toml`.

### Set secrets

```bash
printf '%s' "$STRIPE_SECRET_KEY" | CLOUDFLARE_API_TOKEN=... npx wrangler secret put STRIPE_SECRET_KEY
printf '%s' "$STRIPE_WEBHOOK_SECRET" | CLOUDFLARE_API_TOKEN=... npx wrangler secret put STRIPE_WEBHOOK_SECRET
printf '%s' "$INTERNAL_API_TOKEN" | CLOUDFLARE_API_TOKEN=... npx wrangler secret put INTERNAL_API_TOKEN
printf '%s' "$ADMIN_API_TOKEN" | CLOUDFLARE_API_TOKEN=... npx wrangler secret put ADMIN_API_TOKEN
printf '%s' "$DATABASE_URL" | CLOUDFLARE_API_TOKEN=... npx wrangler secret put DATABASE_URL
```

### Deploy

```bash
CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

## Stripe webhook URL

Use (must match the hostname configured for this Worker in the dashboard):

`https://backend.aipictors.com/webhooks/stripe`

Required Stripe events:

- `checkout.session.completed`
- `invoice.payment_succeeded`
- `customer.subscription.deleted`
- `customer.subscription.trial_will_end`
- `charge.refunded`
