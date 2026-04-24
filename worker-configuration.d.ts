/// <reference types="@cloudflare/workers-types/latest" />

declare global {
  interface Env {
    AIPICTORS_DB: D1Database
    STRIPE_SECRET_KEY?: string
    STRIPE_WEBHOOK_SECRET?: string
    STRIPE_WEBHOOK_PATH?: string
    INTERNAL_API_TOKEN?: string
    ADMIN_API_TOKEN?: string
  }
}

export {}
