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

## Deployment (api.aipictors.com)

This project is configured to deploy to these routes on `aipictors.com`:

- `api.aipictors.com/healthz`
- `api.aipictors.com/internal/*`
- `api.aipictors.com/admin/*`
- `api.aipictors.com/stripe/*`
- `api.aipictors.com/webhooks/stripe`

### Required API Token scopes

Your `CLOUDFLARE_API_TOKEN` must include at least:

- Account: Workers Scripts Write
- Account: Workers Routes Write
- Account: Workers KV Storage Write (optional but commonly required by wrangler account checks)
- Account: D1 Write
- Zone: Zone Read (for route binding)

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

Use:

`https://api.aipictors.com/webhooks/stripe`

Required Stripe events:

- `checkout.session.completed`
- `invoice.payment_succeeded`
- `customer.subscription.deleted`
- `customer.subscription.trial_will_end`
- `charge.refunded`
