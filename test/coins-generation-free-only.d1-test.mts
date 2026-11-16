// 「画像生成にプレミアムコインを使わない」設定: 生成の消費はフリーコインだけ（足りなければ何も引かずに 409）、
// 生成以外の消費・設定オフ・core が読めないときは今まで通り（フリーから先に、足りない分はプレミアム）
import assert from "node:assert/strict"
import { Miniflare } from "miniflare"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const coins = await import(`${API}/lib/coins.ts`)
const setting = await import(`${API}/lib/coins/generation-setting.ts`)

const d1 = await createTestD1()
const db = d1.db

const coreMf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["CORE"] })
const CORE = await coreMf.getD1Database("CORE")
await CORE.prepare("CREATE TABLE user_settings (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, disable_premium_coin_generation INTEGER)").run()

const env: Record<string, unknown> = { DB: d1.DB, GENLOG: d1.GENLOG, SYSTEM_CORE: CORE, INTERNAL_API_TOKEN: "internal" }
const call = async (path: string, body: unknown, overrideEnv = env) => {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method: "POST",
      headers: { authorization: "Bearer internal", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    overrideEnv,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )
  return { status: res.status, body: (await res.json()) as { error: string | null; data: any; freeOnly?: boolean } }
}
const balances = async (u: string) => {
  const s = await coins.getCoinSummary(db, u, {})
  return [s.freeBalance, s.premiumBalance]
}
// 消費の前に今日の日次コインが付くので、先に受け取ってから残高を作る
const prepare = async (u: string, free: number, premium: number) => {
  await coins.ensureInitialCoinGrant({ db, userId: u, planType: "FREE" })
  const [f, p] = await balances(u)
  await coins.applyCoinDelta({ db, userId: u, freeDelta: free - f, premiumDelta: premium - p, kind: "GRANT", reason: "test" })
  assert.deepEqual(await balances(u), [free, premium])
}

let passed = 0
const t = async (name: string, fn: () => Promise<void>) => {
  await fn()
  passed++
  console.log(`ok  ${name}`)
}

await t("consumeCoins freeOnly: プレミアムを使わず、フリーが足りなければ何も引かない", async () => {
  await prepare("10", 300, 5000)
  assert.deepEqual(await coins.consumeCoins({ db, userId: "10", amount: 400, reason: "image-generation:txt2img", freeOnly: true }), { ok: false, code: "INSUFFICIENT_COINS" })
  assert.deepEqual(await balances("10"), [300, 5000])
  const ok = await coins.consumeCoins({ db, userId: "10", amount: 300, reason: "image-generation:txt2img", freeOnly: true })
  assert.deepEqual([ok.ok, ok.freeSpent, ok.premiumSpent], [true, 300, 0])
  assert.deepEqual(await balances("10"), [0, 5000])
})

await t("consumeCoins freeOnly: 同時に来てもフリーの残りの分だけ通る", async () => {
  await prepare("11", 1000, 100000)
  const rs = await Promise.all(Array.from({ length: 8 }, () => coins.consumeCoins({ db, userId: "11", amount: 300, freeOnly: true })))
  assert.equal(rs.filter((r) => r.ok).length, 3)
  assert.deepEqual(await balances("11"), [100, 100000])
})

await t("設定オン: 生成（reason が image-generation:）はフリーだけ。足りなければ 409 で残高はそのまま", async () => {
  await prepare("20", 300, 5000)
  await CORE.prepare("INSERT INTO user_settings(userId, disable_premium_coin_generation) VALUES (20, 1)").run()
  for (const reason of ["image-generation:txt2img", "image-generation:reserved:img2img", "image-generation:flux", "image-generation:gemini-2.5-flash-image"]) {
    const r = await call("/internal/coins/consume", { userId: "20", amount: 400, reason, source: "task:x" })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, "Insufficient free coins")
    assert.equal(r.body.freeOnly, true)
  }
  assert.deepEqual(await balances("20"), [300, 5000])
  const ok = await call("/internal/coins/consume", { userId: "20", amount: 200, reason: "image-generation:txt2img", source: "task:y" })
  assert.equal(ok.status, 200)
  assert.deepEqual([ok.body.data.freeSpent, ok.body.data.premiumSpent], [200, 0])
})

await t("設定オンでも生成以外（アイコン枠・宣伝枠など）は今まで通りプレミアムも使う", async () => {
  const r = await call("/internal/coins/consume", { userId: "20", amount: 400, reason: "アイコン枠「x」を購入", source: "avatar-frame:1" })
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.data.freeSpent, r.body.data.premiumSpent], [100, 300])
})

await t("設定オフ・設定の行が無い人は今まで通り（フリーから先に、足りない分はプレミアム）", async () => {
  await prepare("21", 300, 5000)
  await CORE.prepare("INSERT INTO user_settings(userId, disable_premium_coin_generation) VALUES (21, 0)").run()
  const off = await call("/internal/coins/consume", { userId: "21", amount: 400, reason: "image-generation:txt2img", source: "task:z" })
  assert.deepEqual([off.status, off.body.data.freeSpent, off.body.data.premiumSpent], [200, 300, 100])
  await prepare("22", 300, 5000)
  const none = await call("/internal/coins/consume", { userId: "22", amount: 400, reason: "image-generation:txt2img", source: "task:z" })
  assert.deepEqual([none.status, none.body.data.freeSpent, none.body.data.premiumSpent], [200, 300, 100])
})

await t("core が読めない・列が無いときは設定オフ扱い（生成を止めない）", async () => {
  assert.equal(await setting.isPremiumCoinGenerationDisabled(null, "20"), false)
  assert.equal(await setting.isPremiumCoinGenerationDisabled(CORE, "abc"), false)
  assert.equal(await setting.isPremiumCoinGenerationDisabled(CORE, "20"), true)
  const broken = { prepare: () => { throw new Error("no such column: disable_premium_coin_generation") } }
  assert.equal(await setting.isPremiumCoinGenerationDisabled(broken, "20"), false)
  await prepare("23", 300, 5000)
  const r = await call("/internal/coins/consume", { userId: "23", amount: 400, reason: "image-generation:txt2img" }, { ...env, SYSTEM_CORE: broken })
  assert.deepEqual([r.status, r.body.data.freeSpent, r.body.data.premiumSpent], [200, 300, 100])
})

await t("isImageGenerationCoinReason", async () => {
  assert.equal(setting.isImageGenerationCoinReason("image-generation:flux"), true)
  assert.equal(setting.isImageGenerationCoinReason("推し"), false)
  assert.equal(setting.isImageGenerationCoinReason(null), false)
})

console.log(`\n${passed} passed`)
await d1.dispose()
await coreMf.dispose()
process.exit(0)
