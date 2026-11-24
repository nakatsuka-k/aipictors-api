// フリーコインの推し: 推した枚数の 2/3（切り捨て）が、受け取った人に期限付き（30 日）のフリーコインとして入る（1 日 300 枚まで、超えた分は pt だけ）。
// 取り消しでは残っている分だけ取り戻す。プレミアムコインの推しは今まで通り（期限なしのプレミアムコイン）
import assert from "node:assert/strict"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const coins = await import(`${API}/lib/coins.ts`)
const support = await import(`${API}/lib/coin-support/transfer.ts`)
const recipient = await import(`${API}/lib/coin-support/recipient.ts`)

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

// 200 枚: 2/3 の 133 枚がフリーコインになる（期限 30 日）。pt は 200 のまま
const first = await send({ from: "s1", to: "r1", coinType: "FREE", amount: 200, source: "t-1" })
assert.equal(first.ok, true)
assert.equal(first.receivedFreeCoins, 133)
assert.equal(first.recipientPtAdded, 200)
assert.deepEqual(await balances("r1"), [r1Free + 133, 0])
const lot = await db.queryOne<{ remaining: number; expires_at: number; created_at: number }>(
  "SELECT remaining, expires_at, created_at FROM coin_lots WHERE user_id = 'r1' AND source_kind = 'SUPPORT' AND source_ref_id = 't-1'",
)
assert.equal(lot?.remaining, 133)
assert.equal((lot?.expires_at ?? 0) - (lot?.created_at ?? 0), 30 * 86400)

// 別の人から 300 枚（2/3 は 200 枚）: 上限 300 の残り 167 枚だけコイン、pt は 300 のまま
const second = await send({ from: "s2", to: "r1", coinType: "FREE", amount: 300, source: "t-2" })
assert.equal(second.ok, true)
assert.equal(second.receivedFreeCoins, 167)
assert.equal(second.recipientPtAdded, 300)
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
assert.deepEqual(await balances("r1"), [r1Free + 133, 500])
const gone = await db.queryOne<{ n: number }>(
  "SELECT COUNT(*) AS n FROM coin_lots WHERE user_id = 'r1' AND coin_type = 'FREE' AND source_ref_id = 't-2'",
)
assert.equal(gone?.n, 0)

// 取り消した分は今日の上限から外れる
const again = await send({ from: "s2", to: "r1", coinType: "FREE", amount: 300, source: "t-5" })
assert.equal(again.receivedFreeCoins, 167)

// 「推しでフリーコインを受け取らない」設定の人（上限 0）: pt だけ付き、コインは渡さない（送る人のコインは減る）
await prepare("r2", 0, 0)
const [r2Free] = await balances("r2")
const rejected = await support.transferSupportCoins({
  db,
  senderUserId: "s1",
  recipientUserId: "r2",
  coinType: "FREE",
  amount: 40,
  reason: "coin support",
  source: "t-6",
  freeReceiveDailyLimit: 0,
})
assert.equal(rejected.ok, true)
assert.equal(rejected.receivedFreeCoins, 0)
assert.equal(rejected.recipientPtAdded, 40)
assert.deepEqual(await balances("r2"), [r2Free, 0])

// 推しで受け取ったフリーコインもまた推しに使える（回すたびに 1/3 減るので、回し続けても pt は元の枚数の 3 倍まで）
await prepare("loopA", 0, 0)
await prepare("loopB", 100, 0)
const [loopAFree] = await balances("loopA")
const toA = await send({ from: "loopB", to: "loopA", coinType: "FREE", amount: 100, source: "loop-1" })
assert.equal(toA.receivedFreeCoins, 66)
assert.deepEqual(await balances("loopA"), [loopAFree + 66, 0])
const back = await send({ from: "loopA", to: "loopB", coinType: "FREE", amount: loopAFree + 66, source: "loop-2" })
assert.equal(back.ok, true)
assert.equal(back.receivedFreeCoins, Math.floor((loopAFree + 66) * 2 / 3))
assert.deepEqual(await balances("loopA"), [0, 0])
// 1 枚の推しは受け取り 0 枚（pt は付く）
const one = await send({ from: "loopB", to: "loopA", coinType: "FREE", amount: 1, source: "loop-3" })
assert.equal(one.ok, true)
assert.equal(one.receivedFreeCoins, 0)
assert.equal(one.recipientPtAdded, 1)
assert.deepEqual(await balances("loopA"), [0, 0])

// 受け取る人の設定は core の user_settings から読む。読めないときは受け取る扱い
const fakeCore = (row: unknown, fail = false) => ({
  prepare: () => ({ bind: () => ({ first: async () => { if (fail) throw new Error("no column"); return row } }) }),
})
assert.deepEqual(await recipient.getSupportRecipientSettings(fakeCore({ premium: 0, free: 1 }), "12"), { rejectPremium: false, rejectFreeReceive: true, rejectAll: false })
assert.deepEqual(await recipient.getSupportRecipientSettings(fakeCore({ premium: 1, free: null }), "12"), { rejectPremium: true, rejectFreeReceive: false, rejectAll: false })
assert.deepEqual(await recipient.getSupportRecipientSettings(fakeCore(null, true), "12"), { rejectPremium: false, rejectFreeReceive: false, rejectAll: false })
assert.deepEqual(await recipient.getSupportRecipientSettings(fakeCore({ premium: 0, free: 0, all_support: 1 }), "12"), { rejectPremium: false, rejectFreeReceive: false, rejectAll: true })

console.log("coin-support-free ok")
await d1.dispose()
process.exit(0)
