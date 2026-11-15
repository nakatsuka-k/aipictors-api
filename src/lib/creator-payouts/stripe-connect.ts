// @ts-nocheck
// Stripe Connect（Express）の API。テストでは fetch を差し替える

export class StripeApiError extends Error {
  constructor(message, { status, code, type, declineCode } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.type = type
    this.declineCode = declineCode
  }
}

const encodeForm = (params, prefix = "", out = new URLSearchParams()) => {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (typeof value === "object" && !Array.isArray(value)) encodeForm(value, name, out)
    else if (Array.isArray(value)) value.forEach((v, i) => out.append(`${name}[${i}]`, String(v)))
    else out.append(name, String(value))
  }
  return out
}

/** Stripe に渡せる形のメールだけを返す（空・空白・@ のないものは undefined） */
export const toStripeEmail = (email) => {
  const value = typeof email === "string" ? email.trim() : ""
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : undefined
}

export const createStripeClient = ({ secretKey, fetchImpl = fetch }) => {
  if (!secretKey) throw new Error("Stripe Connect の鍵が設定されていません")
  const call = async (method, path, params, { idempotencyKey } = {}) => {
    const headers = { Authorization: `Bearer ${secretKey}` }
    let url = `https://api.stripe.com${path}`
    let body
    if (method === "GET") {
      const query = encodeForm(params).toString()
      if (query) url += `?${query}`
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded"
      body = encodeForm(params).toString()
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey
    const response = await fetchImpl(url, { method, headers, body })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) {
      const e = json?.error ?? {}
      throw new StripeApiError(e.message ?? `Stripe ${response.status}`, {
        status: response.status,
        code: e.code,
        type: e.type,
        declineCode: e.decline_code,
      })
    }
    return json
  }
  return {
    livemode: secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_"),
    /** 日本の Express アカウント（送金を受け取るだけ） */
    createExpressAccount: ({ userId, email, siteOrigin }) =>
      call(
        "POST",
        "/v1/accounts",
        {
          type: "express",
          country: "JP",
          // プロフィールのメール欄が空（""）や形の違う文字のときは送らない（Stripe が "Invalid email address" で断る。メールは登録画面で本人が入れる）
          email: toStripeEmail(email),
          capabilities: { transfers: { requested: true } },
          business_profile: {
            mcc: "7333",
            product_description: "Aipictors に投稿したイラスト作品への応援に応じたクリエイター報酬の受け取り",
            url: `${siteOrigin}/users/${userId}`,
          },
          metadata: { aipictors_user_id: String(userId) },
        },
        { idempotencyKey: `creator-account:${userId}:${secretKey.startsWith("sk_live_") ? "live" : "test"}` },
      ),
    retrieveAccount: (accountId) => call("GET", `/v1/accounts/${accountId}`),
    createAccountLink: ({ accountId, refreshUrl, returnUrl }) =>
      call("POST", "/v1/account_links", {
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding",
        collection_options: { fields: "eventually_due" },
      }),
    createLoginLink: (accountId) => call("POST", `/v1/accounts/${accountId}/login_links`, {}),
    listTransfersByGroup: (transferGroup) => call("GET", "/v1/transfers", { transfer_group: transferGroup, limit: 10 }),
    createTransfer: ({ amount, destination, transferGroup, description, metadata, idempotencyKey }) =>
      call(
        "POST",
        "/v1/transfers",
        { amount, currency: "jpy", destination, transfer_group: transferGroup, description, metadata },
        { idempotencyKey },
      ),
  }
}

/** Stripe のアカウントから、こちらで持つ状態を取り出す */
export const toAccountState = (account) => {
  const businessType = account?.business_type ?? null
  const structure = account?.company?.structure ?? null
  // 個人事業主（company + sole_proprietorship）も源泉徴収の上では個人
  const taxKind = businessType === "company" && structure !== "sole_proprietorship" ? "CORPORATION" : businessType ? "INDIVIDUAL" : null
  return {
    detailsSubmitted: account?.details_submitted ? 1 : 0,
    payoutsEnabled: account?.payouts_enabled ? 1 : 0,
    transfersActive: account?.capabilities?.transfers === "active" ? 1 : 0,
    taxKind,
    email: account?.email ?? null,
    requirements: {
      currentlyDue: account?.requirements?.currently_due ?? [],
      pastDue: account?.requirements?.past_due ?? [],
      disabledReason: account?.requirements?.disabled_reason ?? null,
      currentDeadline: account?.requirements?.current_deadline ?? null,
    },
  }
}

/** 送金の失敗のうち、翌日にやり直してよいもの（残高不足・一時的な障害） */
export const isRetryableTransferError = (error) => {
  if (!(error instanceof StripeApiError)) return true
  if (error.code === "balance_insufficient" || error.code === "rate_limit") return true
  if (error.type === "api_error" || (error.status ?? 0) >= 500 || error.status === 429) return true
  return false
}
