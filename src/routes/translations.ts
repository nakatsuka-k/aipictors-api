// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// 利用者が書いた文の自動翻訳（lib/translations.ts）。サイトの /api/translate が内部トークンで呼ぶ
import { Hono as Hono2 } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { getNow } from "../lib/db"
import { json } from "../lib/json"
import { MAX_TEXTS, TRANSLATION_TARGETS, translateTexts } from "../lib/translations"

export var translationRoutes = new Hono2()
translationRoutes.use("*", requireInternalAuth)

// { texts: string[], target: "en" | "ja" } → { translations: (string | null)[] }（texts と同じ順。訳せなかったものは null）
translationRoutes.post("/translate", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const target = String(body.target ?? "")
  if (!TRANSLATION_TARGETS.has(target)) return json({ error: "target must be en or ja" }, 400)
  if (!Array.isArray(body.texts) || body.texts.length === 0) return json({ error: "texts is required" }, 400)
  if (body.texts.length > MAX_TEXTS) return json({ error: `texts must be ${MAX_TEXTS} or fewer` }, 400)
  const translations = await translateTexts({ db: c.env.DB, texts: body.texts, target, now: getNow() })
  return json({ error: null, data: { translations } })
})
