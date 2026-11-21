// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// 利用者が書いた文の自動翻訳（英語の画面で日本語のコメント・プロフィール文・リクエストの文などを英語で出す）。
// 翻訳は Google Apps Script（サイトの手動翻訳と同じもの。1 日の回数に上限がある）。
// 訳した結果は D1 の text_translations に置き、同じ文は 2 回目から Apps Script を呼ばない

export const GOOGLE_APPS_SCRIPT_TRANSLATE_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbw1D0NqYxBiJvN00CZLCnoDIpWtK_cib_JDY7sva_Mlwr-XVjabRSWDooBBvVlgZUPU/exec"

export const TRANSLATION_TARGETS = new Set(["en", "ja"])
/** 1 回に受け付ける文の数 */
export const MAX_TEXTS = 50
/** 1 つの文の長さ（これより長い文は訳さない） */
export const MAX_TEXT_LENGTH = 3000
/** Apps Script の URL に入る長さ（日本語は 1 文字 9 バイトになる） */
const MAX_ENCODED_LENGTH = 8000
const SEPARATOR = "\n§§§\n"

export const hashText = async (text) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Apps Script で 1 回訳す。失敗したら null */
const callAppsScript = async (fetcher, text, target) => {
  const query = new URLSearchParams({ text, target })
  const response = await fetcher(`${GOOGLE_APPS_SCRIPT_TRANSLATE_ENDPOINT}?${query.toString()}`).catch(() => null)
  if (!response?.ok) return null
  const data = await response.json().catch(() => null)
  return typeof data?.text === "string" && data.text.trim() !== "" ? data.text : null
}

/** 近い長さの文をまとめて 1 回で訳す。区切りの数が合わなければそのまとまりは訳せなかった扱い */
const translateWithAppsScript = async (fetcher, texts, target) => {
  const batches = []
  let batch = []
  let length = 0
  for (const text of texts) {
    const itemLength = encodeURIComponent(text).length + 30
    if (batch.length > 0 && length + itemLength > MAX_ENCODED_LENGTH) {
      batches.push(batch)
      batch = []
      length = 0
    }
    batch.push(text)
    length += itemLength
  }
  if (batch.length > 0) batches.push(batch)

  const results = new Map()
  await Promise.all(
    batches.map(async (items) => {
      const translated = await callAppsScript(fetcher, items.join(SEPARATOR), target)
      if (translated === null) return
      const parts = translated.split(/\s*§§§\s*/)
      if (parts.length !== items.length) return
      items.forEach((item, index) => {
        const part = parts[index].trim()
        if (part !== "") results.set(item, part)
      })
    }),
  )
  return results
}

/**
 * 文をまとめて訳す。返すのは texts と同じ順の訳（訳せなかったものは null）。
 * 保存済みの訳はそのまま返し、まだのものだけ Apps Script で訳して保存する
 */
export const translateTexts = async ({ db, texts, target, now, fetcher = fetch }) => {
  const items = await Promise.all(
    texts.map(async (raw) => {
      const text = typeof raw === "string" ? raw.trim() : ""
      if (text === "" || text.length > MAX_TEXT_LENGTH) return null
      return { text, hash: await hashText(text) }
    }),
  )
  const hashes = [...new Set(items.filter(Boolean).map((item) => item.hash))]
  const saved = new Map()
  if (hashes.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT source_hash, translated FROM text_translations WHERE target = ? AND source_hash IN (${hashes.map(() => "?").join(",")})`,
      )
      .bind(target, ...hashes)
      .all()
    for (const row of results ?? []) saved.set(row.source_hash, row.translated)
  }

  const missing = [...new Map(items.filter((item) => item && !saved.has(item.hash)).map((item) => [item.hash, item])).values()]
  if (missing.length > 0) {
    const translated = await translateWithAppsScript(fetcher, missing.map((item) => item.text), target)
    const rows = missing.filter((item) => translated.has(item.text))
    for (const item of rows) saved.set(item.hash, translated.get(item.text))
    if (rows.length > 0) {
      await db.batch(
        rows.map((item) =>
          db
            .prepare(
              `INSERT INTO text_translations (source_hash, target, translated, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (source_hash, target) DO NOTHING`,
            )
            .bind(item.hash, target, translated.get(item.text), now),
        ),
      )
    }
  }

  return items.map((item) => (item ? (saved.get(item.hash) ?? null) : null))
}
