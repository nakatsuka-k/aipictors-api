// 利用者が書いた文の自動翻訳: 保存済みの訳は Apps Script を呼ばずに返す・まとめて訳す・失敗は保存しない
import assert from "node:assert/strict"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { translateTexts } = await import(`${API}/lib/translations.ts`)

const d1 = await createTestD1()

// Apps Script の代わり: 区切りごとに「EN:」を付けて返す。呼ばれた回数と文を記録する
const calls: string[] = []
let failNext = false
const fetcher = async (url: string) => {
  const params = new URL(url).searchParams
  const text = params.get("text") ?? ""
  calls.push(text)
  if (failNext) {
    failNext = false
    return new Response("error", { status: 500 })
  }
  const translated = text
    .split("\n§§§\n")
    .map((part) => `EN:${part}`)
    .join("\n§§§\n")
  return Response.json({ text: translated })
}

try {
  // 1 回目: まとめて 1 回で訳す。空・同じ文は 1 つにまとめる
  const first = await translateTexts({ db: d1.DB, texts: ["こんにちは", " ", "ありがとう", "こんにちは"], target: "en", now: 100, fetcher })
  assert.deepEqual(first, ["EN:こんにちは", null, "EN:ありがとう", "EN:こんにちは"])
  assert.equal(calls.length, 1)
  assert.equal(calls[0], "こんにちは\n§§§\nありがとう")

  // 2 回目: 保存済みは呼ばない。新しい文だけ訳す
  const second = await translateTexts({ db: d1.DB, texts: ["ありがとう", "またね"], target: "en", now: 200, fetcher })
  assert.deepEqual(second, ["EN:ありがとう", "EN:またね"])
  assert.equal(calls.length, 2)
  assert.equal(calls[1], "またね")

  // 全部保存済みなら 1 回も呼ばない
  await translateTexts({ db: d1.DB, texts: ["こんにちは", "またね"], target: "en", now: 300, fetcher })
  assert.equal(calls.length, 2)

  // 訳す言語が違えば別に訳す
  const ja = await translateTexts({ db: d1.DB, texts: ["こんにちは"], target: "ja", now: 300, fetcher })
  assert.deepEqual(ja, ["EN:こんにちは"])
  assert.equal(calls.length, 3)

  // 失敗したら null で、保存しない（次にまた訳す）
  failNext = true
  assert.deepEqual(await translateTexts({ db: d1.DB, texts: ["おやすみ"], target: "en", now: 400, fetcher }), [null])
  assert.deepEqual(await translateTexts({ db: d1.DB, texts: ["おやすみ"], target: "en", now: 400, fetcher }), ["EN:おやすみ"])
  assert.equal(calls.length, 5)

  // 長すぎる文は訳さない
  assert.deepEqual(await translateTexts({ db: d1.DB, texts: ["あ".repeat(3001)], target: "en", now: 500, fetcher }), [null])
  assert.equal(calls.length, 5)

  // 原文は保存しない（ハッシュだけ）
  const { results } = await d1.DB.prepare("SELECT source_hash, target, translated FROM text_translations ORDER BY created_at").all()
  assert.equal(results.length, 5)
  assert.ok(results.every((row: any) => /^[0-9a-f]{64}$/.test(row.source_hash)))

  console.log("translations ok")
} finally {
  await d1.dispose()
}
