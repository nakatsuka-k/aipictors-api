// Discord 連携を本物の Postgres と偽の Discord API で検証する
import EmbeddedPostgres from "embedded-postgres"
import pg from "pg"
import assert from "node:assert/strict"

const API = new URL("../src", import.meta.url).pathname
const { schemaStatements } = await import(`${API}/lib/db.ts`)
const d = await import(`${API}/lib/discord.ts`)

const dir = `/tmp/discord-test-pg-${process.pid}`
const epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: 54331, persistent: false, onLog: () => {}, onError: () => {} })
await epg.initialise()
await epg.start()
await epg.createDatabase("t")
const pool = new pg.Pool({ connectionString: "postgres://postgres:pw@127.0.0.1:54331/t", max: 10 })
pg.types.setTypeParser(20, (v) => Number(v))
const db = {
  async query(text: string, params: unknown[] = []) { return (await pool.query(text, params)).rows },
  async queryOne(text: string, params: unknown[] = []) { return (await pool.query(text, params)).rows[0] ?? null },
  async execute(text: string, params: unknown[] = []) { await pool.query(text, params) },
  async executeResult(text: string, params: unknown[] = []) { return { rowCount: (await pool.query(text, params)).rowCount ?? 0 } },
  async lockedQuery(_k: string[], text: string, params: unknown[] = []) { return (await pool.query(text, params)).rows },
  async lockedQueryOne(_k: string[], text: string, params: unknown[] = []) { return (await pool.query(text, params)).rows[0] ?? null },
}
for (const s of schemaStatements) await db.execute(s)

/* 偽の Discord と GraphQL */
const G = d.DISCORD_GUILD_ID
const world: any = {
  me: { id: "900", username: "kirito", global_name: "きりと", avatar: "a" },
  member: { user: { id: "900", username: "kirito", global_name: "きりと" }, nick: null, roles: ["jp"] } as any,
  roles: [{ id: "botrole", position: 20 }],
  summary: { level: 42, points: 17000, unlockedCount: 115, totalCount: 400 } as any,
  achievements: [
    { key: "gold-one", name: "金の実績", tier: 3, isUnlocked: true, isHidden: false, unlockedAt: 0 },
    { key: "locked", name: "未達成", tier: 3, isUnlocked: false, isHidden: false, unlockedAt: null },
  ],
  nickForbidden: false,
  messages: [] as any[],
  dms: [] as any[],
  roleConnections: [] as any[],
  created: 0,
  revoked: 0,
  tokenCalls: [] as string[],
  tokenInvalid: false,
  tokenScope: "identify role_connections.write",
}
const ok = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const fakeFetch = async (input: string, init: any = {}) => {
  const url = String(input)
  const method = init.method ?? "GET"
  const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body
  if (url.includes("api.aipictors.com")) {
    return ok({ data: { user: { login: "kirito", name: "きりと" }, achievementSummary: world.summary, achievements: world.summary ? world.achievements : [] } })
  }
  if (url.includes("assets.aipictors.com")) return new Response(new Uint8Array([1, 2, 3]))
  const path = url.replace(d.DISCORD_API, "")
  if (path === "/oauth2/token") {
    world.tokenCalls.push(body.get("grant_type"))
    assert.equal(body.get("client_secret"), null, "公開クライアントなので secret は送らない")
    if (body.get("grant_type") === "authorization_code") assert.equal(body.get("code_verifier"), "v")
    if (world.tokenInvalid) return ok({ error: "invalid_grant" }, 400)
    return ok({ access_token: `at-${world.tokenCalls.length}`, refresh_token: `rt-${world.tokenCalls.length}`, expires_in: 604800, scope: world.tokenScope })
  }
  if (path === "/oauth2/token/revoke") { world.revoked++; return ok({}) }
  if (path === "/users/@me") return ok(world.me)
  if (path === `/guilds/${G}/members/${d.DISCORD_BOT_USER_ID}`) return ok({ roles: ["botrole"] })
  if (path.startsWith(`/guilds/${G}/members/`)) {
    const [, , , , id, , roleId] = path.split("/")
    if (id !== world.me.id || world.member === null) return ok({ message: "Unknown Member", code: 10007 }, 404)
    if (roleId && method === "PUT") { world.member.roles.push(roleId); return ok(null, 204) }
    if (roleId && method === "DELETE") { world.member.roles = world.member.roles.filter((r: string) => r !== roleId); return ok(null, 204) }
    if (method === "PATCH") {
      if (world.nickForbidden) return ok({ message: "Missing Permissions", code: 50013 }, 403)
      assert.ok((body.nick ?? "").length <= 32, "ニックネームは 32 文字まで")
      world.member.nick = body.nick
      return ok(world.member)
    }
    return ok(world.member)
  }
  if (path === `/guilds/${G}/roles` && method === "POST") {
    world.created++
    const role = { id: `role-${world.created}`, position: 1, name: body.name, icon: body.icon }
    world.roles.push(role)
    return ok(role)
  }
  if (path === `/guilds/${G}/roles`) return ok(world.roles)
  if (path.startsWith(`/guilds/${G}/roles/`) && method === "DELETE") return ok(null, 204)
  if (path.startsWith("/users/@me/applications/")) {
    if (world.tokenInvalid) return ok({ message: "401", code: 0 }, 401)
    world.roleConnections.push({ auth: init.headers.authorization, ...body })
    return ok({})
  }
  if (path === "/users/@me/channels") return ok({ id: "dm-1" })
  if (path === "/channels/dm-1/messages") { world.dms.push(body); return ok({ id: "m" }) }
  if (path.startsWith("/channels/")) { world.messages.push(body); return ok({ id: "m" }) }
  throw new Error(`unexpected ${method} ${path}`)
}
const env: any = {
  __fetch: fakeFetch,
  DISCORD_BOT_TOKEN: "bot",
  DISCORD_ROLE_METADATA_ENABLED: "1",
  DISCORD_TOKEN_KEY: "key",
  DISCORD_CELEBRATION_CHANNEL_ID: "celebrate",
}

let passed = 0
const test = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log("ok -", name) } catch (e) { console.log("FAIL -", name, e); process.exitCode = 1 }
}
// 残高は coin_lots が正（coin_balances は読むときに合わせ直す）
const balance = async (u: string) => (await db.queryOne("SELECT COALESCE(SUM(remaining), 0)::INTEGER AS total FROM coin_lots WHERE user_id = $1 AND coin_type = 'FREE'", [u])).total

await test("名前の整形: 32 文字に収める・絵文字を切らない・付け外しできる", async () => {
  assert.equal(d.toNickWithLevel("きりと", 42), "きりと ✦Lv.42")
  assert.equal(d.stripNickSuffix("きりと ✦Lv.42"), "きりと")
  assert.equal(d.stripNickSuffix("Lv.42の人"), "Lv.42の人")
  const long = d.toNickWithLevel("😀".repeat(30), 100)
  assert.ok(long.length <= 32)
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(long), "サロゲートペアを切らない")
  assert.equal(d.toLevelRole(1).level, 1)
  assert.equal(d.toLevelRole(42).level, 40)
  assert.equal(d.toLevelRole(250).level, 100)
})

await test("連携: トークンは暗号化、ボーナス、ロールとニックネームが付く", async () => {
  const result = await d.linkDiscordAccount(env, db, { userId: "1", code: "c", redirectUri: "u", codeVerifier: "v" })
  assert.deepEqual(result, { ok: true, bonusCoins: 100 })
  const row = await db.queryOne("SELECT * FROM discord_links WHERE user_id = '1'")
  assert.ok(!row.access_token_enc.includes("at-1"), "平文で保存しない")
  assert.equal(await d.decryptToken(env, row.access_token_enc), "at-1")
  assert.equal(world.member.nick, "きりと ✦Lv.42")
  assert.equal(world.member.roles.length, 2, "jp + レベル")
  assert.ok(world.member.roles.includes("jp"))
  assert.equal(row.in_guild, true)
  assert.equal(await balance("1"), 100)
  assert.equal(world.roleConnections.at(-1).metadata.level, "42")
  assert.equal(world.roleConnections.at(-1).platform_name, "Aipictors")
})

await test("強調する実績: 達成済みならアイコンのロールが増え、未達成は付かない", async () => {
  await d.updateDiscordSettings(db, { userId: "1", highlightKey: "locked" })
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.roles.length, 2)
  await d.updateDiscordSettings(db, { userId: "1", highlightKey: "gold-one" })
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.roles.length, 3)
  const role = world.roles.find((r: any) => r.name === "🏅金の実績")
  assert.ok(role.icon.startsWith("data:image/png;base64,"))
  await d.updateDiscordSettings(db, { userId: "1", highlightKey: null })
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.roles.length, 2, "やめたら外れる")
})

await test("レベルが上がるとロールが入れ替わり、関係ないロールは残る", async () => {
  world.summary = { ...world.summary, level: 50 }
  world.member.roles.push("booster")
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.nick, "きりと ✦Lv.50")
  assert.ok(world.member.roles.includes("booster"))
  assert.ok(world.member.roles.includes("jp"))
  assert.equal(world.member.roles.length, 3)
})

await test("自分で付けたニックネームを残す・Discord の表示名の変更についていく", async () => {
  world.member.user.global_name = "新しい名前"
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.nick, "新しい名前 ✦Lv.50")
  world.member.nick = "自分の呼び名"
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.nick, "自分の呼び名 ✦Lv.50")
  await d.updateDiscordSettings(db, { userId: "1", showNickname: false })
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.nick, "自分の呼び名", "オフで元に戻る")
  await d.updateDiscordSettings(db, { userId: "1", showNickname: true })
  await d.syncDiscordLinkByUserId(env, db, "1")
})

await test("管理者などニックネームを変えられない人でも、ほかは止めない", async () => {
  world.nickForbidden = true
  world.summary = { ...world.summary, level: 51 }
  await d.syncDiscordLinkByUserId(env, db, "1")
  const status = await d.toDiscordStatus(db, "1")
  assert.equal(status.link.nickStatus, "no_permission")
  assert.equal(status.link.level, 51)
  world.nickForbidden = false
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal((await d.toDiscordStatus(db, "1")).link.nickStatus, "ok")
})

await test("実績を非公開にすると、ロールとレベル表示を外す", async () => {
  const saved = world.summary
  world.summary = null
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.nick, "自分の呼び名")
  assert.deepEqual(world.member.roles.sort(), ["booster", "jp"])
  assert.equal((await d.toDiscordStatus(db, "1")).link.isAchievementVisible, false)
  world.summary = saved
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.roles.length, 3)
})

await test("お祝い: 希望者だけ、ゴールド以上で新しく達成したものを 1 回だけ。メンションで通知しない", async () => {
  const now = Math.floor(Date.now() / 1000)
  world.achievements.push({ key: "new-gold", name: "新しい金", tier: 3, isUnlocked: true, isHidden: false, unlockedAt: now + 5 })
  world.achievements.push({ key: "new-bronze", name: "銅", tier: 1, isUnlocked: true, isHidden: false, unlockedAt: now + 5 })
  await d.updateDiscordSettings(db, { userId: "1", celebrate: false })
  await db.execute("UPDATE discord_links SET celebrated_until = $1 WHERE user_id = '1'", [now])
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.messages.length, 0, "オフの人は投稿しない")
  await db.execute("UPDATE discord_links SET celebrated_until = $1, celebrate = TRUE WHERE user_id = '1'", [now])
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.messages.length, 1)
  assert.equal(world.messages[0].embeds.length, 1)
  assert.equal(world.messages[0].embeds[0].title, "🏅 新しい金")
  assert.deepEqual(world.messages[0].allowed_mentions, { parse: [] })
})

await test("期限切れのトークンは取り直す。取り消されていても同期は続く", async () => {
  await db.execute("UPDATE discord_links SET token_expires_at = 1 WHERE user_id = '1'")
  world.summary = { ...world.summary, level: 52 }
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.tokenCalls.at(-1), "refresh_token")
  assert.ok((await db.queryOne("SELECT token_expires_at FROM discord_links WHERE user_id = '1'")).token_expires_at > 1000)
  world.tokenInvalid = true
  await db.execute("UPDATE discord_links SET token_expires_at = 1 WHERE user_id = '1'")
  world.summary = { ...world.summary, level: 53 }
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal(world.member.nick, "自分の呼び名 ✦Lv.53")
  assert.equal((await d.toDiscordStatus(db, "1")).link.isProfileConnected, false)
  world.tokenInvalid = false
})

await test("サーバーにいない人は記録だけ。参加後の同期で付く", async () => {
  const saved = world.member
  world.member = null
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal((await d.toDiscordStatus(db, "1")).link.isInGuild, false)
  world.member = saved
  await d.syncDiscordLinkByUserId(env, db, "1")
  assert.equal((await d.toDiscordStatus(db, "1")).link.isInGuild, true)
})

await test("同じ Discord アカウントを別のユーザーで連携できない", async () => {
  const result = await d.linkDiscordAccount(env, db, { userId: "2", code: "c", redirectUri: "u", codeVerifier: "v" })
  assert.deepEqual(result, { ok: false, code: "DISCORD_ALREADY_LINKED" })
  assert.equal(await balance("2"), 0)
})

await test("解除: ロールとニックネームを戻す。解除→再連携でボーナスは増えない", async () => {
  const before = await balance("1")
  await d.unlinkDiscordAccount(env, db, "1")
  assert.equal(world.member.nick, "自分の呼び名")
  assert.deepEqual(world.member.roles.sort(), ["booster", "jp"])
  assert.equal(world.revoked, 0, "取り消し済みのトークンは送らない")
  assert.equal((await d.toDiscordStatus(db, "1")).isLinked, false)
  const again = await d.linkDiscordAccount(env, db, { userId: "1", code: "c", redirectUri: "u", codeVerifier: "v" })
  assert.deepEqual(again, { ok: true, bonusCoins: 0 })
  assert.equal(await balance("1"), before)
  await d.unlinkDiscordAccount(env, db, "1")
  assert.equal(world.revoked, 1, "持っているトークンは取り消す")
  // 同じ Discord アカウントを別のユーザーに移しても、ボーナスはもう付かない
  const moved = await d.linkDiscordAccount(env, db, { userId: "3", code: "c", redirectUri: "u", codeVerifier: "v" })
  assert.deepEqual(moved, { ok: true, bonusCoins: 0 })
  assert.equal(await balance("3"), 0)
})

await test("バッチ: 頼まれた人を先に。1 人の失敗で止まらない", async () => {
  await db.execute(`INSERT INTO discord_links(user_id, discord_user_id, created_at, updated_at, synced_at) VALUES ('9', '999', 1, 1, 1)`)
  await db.execute("UPDATE discord_links SET sync_requested_at = 5 WHERE user_id = '3'")
  const result = await d.runDiscordSyncBatch(env, db, 10)
  assert.equal(result.synced, 2)
})

await test("失効前の DM: 希望者だけ、当日失効の毎日のコインは除く、1 日 1 回", async () => {
  const now = Math.floor(Date.now() / 1000)
  await d.updateDiscordSettings(db, { userId: "3", expiryDm: true })
  // 毎日のコイン（当日失効）
  await db.execute(`INSERT INTO coin_lots(user_id, coin_type, remaining, expires_at, created_at, updated_at) VALUES ('3','FREE',100,$1,$2,$2)`, [now + 3600, now - 3600])
  assert.equal((await d.sendCoinExpiryDms(env, db, now)).sent, 0)
  // 実績の報酬（7 日有効で残り 1 日）
  await db.execute(`INSERT INTO coin_lots(user_id, coin_type, remaining, expires_at, created_at, updated_at) VALUES ('3','FREE',50,$1,$2,$2)`, [now + 86400, now - 6 * 86400])
  const first = await d.sendCoinExpiryDms(env, db, now)
  assert.equal(first.sent, 1)
  assert.ok(world.dms[0].content.includes("フリーコイン 50 枚"))
  assert.equal((await d.sendCoinExpiryDms(env, db, now)).sent, 0)
})

await test("identify だけの連携: トークンを持たずに取り消し、プロフィールの更新もしない", async () => {
  await d.unlinkDiscordAccount(env, db, "3")
  const revoked = world.revoked
  const connections = world.roleConnections.length
  world.tokenScope = "identify"
  world.summary = { ...world.summary, level: 60 }
  const result = await d.linkDiscordAccount(env, db, { userId: "3", code: "c", redirectUri: "u", codeVerifier: "v" })
  assert.deepEqual(result, { ok: true, bonusCoins: 0 })
  const row = await db.queryOne("SELECT access_token_enc, refresh_token_enc FROM discord_links WHERE user_id = '3'")
  assert.equal(row.access_token_enc, null)
  assert.equal(row.refresh_token_enc, null)
  assert.equal(world.revoked, revoked + 1)
  assert.equal(world.roleConnections.length, connections)
  assert.ok(world.member.nick.endsWith("✦Lv.60"))
})

console.log(`\n${passed} passed`)
await pool.end()
await epg.stop()
process.exit(process.exitCode ?? 0)
