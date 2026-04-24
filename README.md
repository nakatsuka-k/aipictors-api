# aipictors-api

Cloudflare Workers + Hono + D1 based internal API for Aipictors.

This repo centralizes D1-backed APIs that are being migrated out of the legacy system.
Current scope:

- Points ledger and balances
- Stripe point checkout
- Stripe subscription checkout
- Stripe webhook processing
- D1-backed subscription state
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

## D1 setup

1. Create D1 database
2. Apply `sql/schema.sql`
3. Set `AIPICTORS_DB` binding in `wrangler.toml`

## Deployment (`backend.aipictors.com`)

This project deploys custom routes on the zone `aipictors.com` (see `wrangler.toml`):

- `backend.aipictors.com/healthz`
- `backend.aipictors.com/internal/*`
- `backend.aipictors.com/admin/*`
- `backend.aipictors.com/stripe/*`
- `backend.aipictors.com/webhooks/stripe`

### Required API Token scopes

GitHub Actions / CI uses `CLOUDFLARE_API_TOKEN`. Uploading the Worker can succeed while **route sync** fails with `Authentication error [code: 10000]` on `/zones/.../workers/routes` if the token cannot manage **Workers Routes** on the zone that serves those hostnames.

Create a **Custom API Token** (or extend an existing one) with:

**Account (this Cloudflare account)**

- Workers Scripts — Edit  
- D1 — Edit  
- (Optional) Workers KV Storage — Edit — if Wrangler or other tooling needs it  
- (Optional) Workers Tail — Read — for `wrangler tail` only  

**Zone — include the zone `aipictors.com` (not “All zones” unless you intend to)**

- Workers Routes — Edit (required so Wrangler can call the zone Workers Routes API for `backend.aipictors.com` patterns)  
- Zone — Read  

Under **Zone resources**, set **Include → Specific zone → `aipictors.com`**. A token scoped only to the account with no zone, or to a different zone, will reproduce the error you see after “Uploaded aipictors-api”.

Alternatively, use a token whose **Account → Workers Routes** permission covers all zones (Wrangler will then use the account-level routes API); that is broader access, so prefer the zone-scoped token above when possible.

### Set secrets

```bash
printf '%s' "$STRIPE_SECRET_KEY" | CLOUDFLARE_API_TOKEN=... npx wrangler secret put STRIPE_SECRET_KEY
printf '%s' "$STRIPE_WEBHOOK_SECRET" | CLOUDFLARE_API_TOKEN=... npx wrangler secret put STRIPE_WEBHOOK_SECRET
printf '%s' "$INTERNAL_API_TOKEN" | CLOUDFLARE_API_TOKEN=... npx wrangler secret put INTERNAL_API_TOKEN
printf '%s' "$ADMIN_API_TOKEN" | CLOUDFLARE_API_TOKEN=... npx wrangler secret put ADMIN_API_TOKEN
```

### Deploy

```bash
CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

## Stripe webhook URL

Use (must match the hostname in `wrangler.toml` routes):

`https://backend.aipictors.com/webhooks/stripe`

Required Stripe events:

- `checkout.session.completed`
- `invoice.payment_succeeded`
- `customer.subscription.deleted`
- `customer.subscription.trial_will_end`
- `charge.refunded`
