// フリーコインの推し: 受け取った人に期限付き（30 日）のフリーコインとして入る（1 日 300 枚まで、超えた分は pt だけ）。
// 取り消しでは残っている分だけ取り戻す。プレミアムコインの推しは今まで通り（期限なしのプレミアムコイン）
import assert from "node:assert/strict"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const coins = await import(`${API}/lib/coins.ts`)
const support = await import(`${API}/lib/coin-support/transfer.ts`)

const d1 = await createTestD1()
const db = d1.db

const balances = async (u: string) => {
  const s = await coins.getCoinSummary(db, u, {})
  return [s.freeBalance, s.premiumBalance]
}
const prepare = async (u: string, free: number, premium: number) => {
  await coins.ensureInitialCoinGrant({ db, userId: u, planType: "FREE" })
  const [f, p] = await balances(u)
  await coins.applyCoinDelta({ db, userId: u, freeDelta: free - f, premiumDelta: premium - p, kind: "GRANT", reason: "test" })
}
const send = (props: { from: string; to: string; coinType: "FREE" | "PREMIUM"; amount: number; source: string }) =>
  support.transferSupportCoins({
    db,
    senderUserId: props.from,
    recipientUserId: props.to,
    coinType: props.coinType,
    amount: props.amount,
    reason: "coin support",
    source: props.source,
  })

await prepare("s1", 1000, 1000)
await prepare("s2", 1000, 0)
await prepare("r1", 0, 0)
const [r1Free] = await balances("r1")

// 200 枚: 全部フリーコインになる（期限 30 日）
const first = await send({ from: "s1", to: "r1", coinType: "FREE", amount: 200, source: "t-1" })
assert.equal(first.ok, true)
assert.equal(first.receivedFreeCoins, 200)
assert.deepEqual(await balances("r1"), [r1Free + 200, 0])
const lot = await db.queryOne<{ remaining: number; expires_at: number; created_at: number }>(
  "SELECT remaining, expires_at, created_at FROM coin_lots WHERE user_id = 'r1' AND source_kind = 'SUPPORT' AND source_ref_id = 't-1'",
)
assert.equal(lot?.remaining, 200)
assert.equal((lot?.expires_at ?? 0) - (lot?.created_at ?? 0), 30 * 86400)

// 別の人から 200 枚: 上限 300 の残り 100 枚だけコイン、pt は 200 のまま
const second = await send({ from: "s2", to: "r1", coinType: "FREE", amount: 200, source: "t-2" })
assert.equal(second.ok, true)
assert.equal(second.receivedFreeCoins, 100)
assert.equal(second.recipientPtAdded, 200)
assert.deepEqual(await balances("r1"), [r1Free + 300, 0])

// 上限に達したら pt だけ（送る人のコインは減る）
const third = await send({ from: "s1", to: "r1", coinType: "FREE", amount: 50, source: "t-3" })
assert.equal(third.ok, true)
assert.equal(third.receivedFreeCoins, 0)
assert.deepEqual(await balances("r1"), [r1Free + 300, 0])
assert.equal((await balances("s1"))[0], 1000 - 200 - 50)

// プレミアムコインの推しは今まで通り（上限なし・期限なしのプレミアムコイン）
const premium = await send({ from: "s1", to: "r1", coinType: "PREMIUM", amount: 500, source: "t-4" })
assert.equal(premium.ok, true)
assert.equal(premium.receivedFreeCoins, 0)
assert.deepEqual(await balances("r1"), [r1Free + 300, 500])
const premiumLot = await db.queryOne<{ expires_at: number | null }>(
  "SELECT expires_at FROM coin_lots WHERE user_id = 'r1' AND source_kind = 'SUPPORT' AND source_ref_id = 't-4'",
)
assert.equal(premiumLot?.expires_at, null)

// 取り消し: 送った人には全額戻り、受け取った人からは渡したフリーコインを取り戻す
const reverted = await support.revertSupportTransferBySource({ db, senderUserId: "s2", recipientUserId: "r1", source: "t-2" })
assert.equal(reverted.reversed, true)
assert.equal((await balances("s2"))[0], 1000)
assert.deepEqual(await balances("r1"), [r1Free + 200, 500])
const gone = await db.queryOne<{ n: number }>(
  "SELECT COUNT(*) AS n FROM coin_lots WHERE user_id = 'r1' AND coin_type = 'FREE' AND source_ref_id = 't-2'",
)
assert.equal(gone?.n, 0)

// 取り消した分は今日の上限から外れる
const again = await send({ from: "s2", to: "r1", coinType: "FREE", amount: 150, source: "t-5" })
assert.equal(again.receivedFreeCoins, 100)

console.log("coin-support-free ok")
await d1.dispose()
process.exit(0)
