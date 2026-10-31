/// <reference types="@cloudflare/workers-types/latest" />

declare global {
  interface Env {
    DATABASE_URL: string
    STRIPE_SECRET_KEY?: string
    STRIPE_WEBHOOK_SECRET?: string
    STRIPE_WEBHOOK_PATH?: string
    FIRST_MONTH_COUPON_ID?: string
    BILLING_PORTAL_CONFIGURATION_ID?: string
    INTERNAL_API_TOKEN?: string
    ADMIN_API_TOKEN?: string
    USER_MODELS: R2Bucket
    // URL（Civitai）からのモデル取り込み（src/workflows/user-model-import.ts）
    USER_MODEL_IMPORTS?: Workflow<{ modelId: string; downloadUrl: string }>
    // 任意。Civitai のログインが必要なモデルのダウンロードに使う API キー
    CIVITAI_API_TOKEN?: string
  }
}

export {}
