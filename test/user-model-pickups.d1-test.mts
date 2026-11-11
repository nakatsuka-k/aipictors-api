// 週替わりのピックアップモデル: 週の計算・候補の点数と除外・選定（お題の枠・お知らせ・X の下書き）を Miniflare の D1 で確かめる
import assert from "node:assert/strict"
import { Miniflare } from "miniflare"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const p = await import(`${API}/lib/user-model-pickups.ts`)

const d1 = await createTestD1()
const { db, genlog } = d1

// aipictors-system の core / activity（使う列だけ）
const sys = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["CORE", "ACTIVITY"] })
const CORE = await sys.getD1Database("CORE")
const ACTIVITY = await sys.getD1Database("ACTIVITY")
for (const sql of [
  `CREATE TABLE user_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, slug TEXT NOT NULL COLLATE NOCASE, title TEXT NOT NULL,
    description TEXT, participation_guide TEXT, header_image_url TEXT, thumbnail_image_url TEXT, main_tag TEXT NOT NULL COLLATE NOCASE,
    ranking_enabled INTEGER NOT NULL DEFAULT 0, ranking_type TEXT, visibility_type TEXT NOT NULL DEFAULT 'DRAFT', announcement_text TEXT,
    ratings TEXT NOT NULL, is_sensitive INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'DRAFT', participant_count INTEGER NOT NULL DEFAULT 0,
    entry_count INTEGER NOT NULL DEFAULT 0, favorite_count INTEGER NOT NULL DEFAULT 0, view_count INTEGER NOT NULL DEFAULT 0,
    start_at TEXT, end_at TEXT, published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX user_events__uq_user_events_main_tag ON user_events (main_tag)`,
  `CREATE UNIQUE INDEX user_events__uq_user_events_slug ON user_events (slug)`,
  `CREATE TABLE user_event_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, user_event_id INTEGER NOT NULL, tag_name TEXT NOT NULL COLLATE NOCASE,
    is_primary INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '')`,
  `CREATE UNIQUE INDEX user_event_tags__uq ON user_event_tags (user_event_id, tag_name)`,
  `CREATE TABLE wp_users (ID INTEGER PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE user_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER NOT NULL, userName TEXT)`,
  `INSERT INTO wp_users (ID, display_name) VALUES (300, 'wp300'), (400, 'wp400')`,
  `INSERT INTO user_profiles (userId, userName) VALUES (300, 'つくる人')`,
]) {
  await CORE.prepare(sql).run()
}
await ACTIVITY.prepare(
  `CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER NOT NULL, workId INTEGER NOT NULL, comment TEXT NOT NULL,
    stampId INTEGER NOT NULL, ownerUserId INTEGER NOT NULL, notifyInnerCount INTEGER NOT NULL, notifyType INTEGER NOT NULL, notifyTime TEXT NOT NULL,
    commentId INTEGER NOT NULL DEFAULT -1)`,
).run()

// 2026-11-18（水）12:00 JST
const NOW = Math.floor(Date.parse("2026-11-18T03:00:00Z") / 1000)
// 毎時 00〜04 分の回以外は選ばない
assert.equal((await p.runWeeklyPickup({ db, genlog, system: { core: null, activity: null }, now: NOW + 600 })).action, "waiting")

// ---- 週 ----
assert.equal(p.jstWeekStart(NOW), "2026-11-16")
assert.equal(p.jstWeekStart(Math.floor(Date.parse("2026-11-15T15:00:00Z") / 1000)), "2026-11-16") // 月曜 00:00 JST
assert.equal(p.jstWeekStart(Math.floor(Date.parse("2026-11-15T14:59:59Z") / 1000)), "2026-11-09") // 日曜 23:59 JST
assert.equal(p.pickupEventTag("2026-11-16"), "ピックアップモデル_261116")

// ---- モデル ----
const insertModel = async (m: Record<string, unknown>) => {
  const row = {
    kind: "LORA", description: "", base_model: "ILLUSTRIOUS", rating: "G", tags: "[]", thumbnail_url: "https://example.com/t.webp",
    sample_image_urls: '["https://example.com/s1.webp","https://example.com/s2.webp"]', size_bytes: 1, sha256: "x", r2_key: "models/x.safetensors", status: "READY",
    use_count: 0, created_at: NOW - 90 * 86400, updated_at: NOW, source_url: null, source_license: null, ...m,
  }
  const keys = Object.keys(row)
  await db.execute(`INSERT INTO user_models (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row))
}
await insertModel({ id: "aaaaaaaaaaaa", user_id: "300", name: "人気のLoRA", use_count: 500 })
await insertModel({ id: "bbbbbbbbbbbb", user_id: "301", name: "R18のモデル", rating: "R18", kind: "CHECKPOINT", use_count: 900 })
await insertModel({ id: "cccccccccccc", user_id: "302", name: "他サービス不可", kind: "CHECKPOINT", source_url: "https://civitai.com/models/1",
  source_license: JSON.stringify({ allowCommercialUse: ["Image"] }), use_count: 900 })
await insertModel({ id: "dddddddddddd", user_id: "400", name: "そこそこのチェックポイント", kind: "CHECKPOINT", use_count: 100 })
await insertModel({ id: "eeeeeeeeeeee", user_id: "303", name: "誰も使っていない", use_count: 1 })

// ---- 生成（直近 7 日と、それより前） ----
const gen = async (userId: number, createdAt: string, model: string, prompts: string) =>
  genlog.execute(
    `INSERT INTO image_generation_results (user_id, request_content, request_time, status, nanoid, platform, uuid, model_name, prompts, created_at)
     VALUES ($1, '{}', $2, 'DONE', $3, 'web', $3, $4, $5, $2)`,
    [userId, createdAt, `n${Math.random().toString(36).slice(2)}`, model, prompts],
  )
await gen(1, "2026-11-01 00:00:00.000", "user/dddddddddddd.safetensors", "") // 7 日より前は数えない
for (const u of [1, 2, 3]) await gen(u, "2026-11-17 01:00:00.000", "base.safetensors", "1girl, <lora:user_aaaaaaaaaaaa:0.8>, <lora:user_aaaaaaaaaaaa:0.8>")
await gen(4, "2026-11-17 02:00:00.000", "user/dddddddddddd.safetensors", "")
await gen(4, "2026-11-17 03:00:00.000", "user/dddddddddddd.safetensors", "")
await gen(5, "2026-11-17 04:00:00.000", "user/dddddddddddd.safetensors", "")

const usage = await p.collectModelUsage(genlog, NOW - 7 * 86400)
assert.deepEqual(usage.get("aaaaaaaaaaaa"), { generations: 3, users: 3 })
assert.deepEqual(usage.get("dddddddddddd"), { generations: 3, users: 2 })

const deps = { db, genlog, system: { core: CORE, activity: ACTIVITY }, now: NOW }
const candidates = await p.listPickupCandidates(deps)
const byId = Object.fromEntries(candidates.map((c: any) => [c.modelId, c]))
assert.equal(candidates[0].modelId, "aaaaaaaaaaaa")
assert.equal(byId.bbbbbbbbbbbb.excludedReason, "R18")
assert.equal(byId.cccccccccccc.excludedReason, "ライセンス（他サービス不可）")
assert.equal(byId.eeeeeeeeeeee.excludedReason, "利用が少ない")
assert.equal(byId.dddddddddddd.excludedReason, null)

// ---- 自動で選ぶ ----
const run1 = await p.runWeeklyPickup(deps)
assert.equal(run1.action, "picked")
assert.equal(run1.modelId, "aaaaaaaaaaaa")
const current = await p.getCurrentPickup(db, NOW)
assert.equal(current.modelId, "aaaaaaaaaaaa")
assert.equal(current.authorName, "つくる人")
assert.equal(current.eventSlug, "model-pickup-20261116")
assert.equal(current.xDraft, undefined) // 公開用には下書きを出さない

const event = await CORE.prepare("SELECT * FROM user_events WHERE slug = 'model-pickup-20261116'").first<any>()
assert.equal(event.user_id, 1)
assert.equal(event.main_tag, "ピックアップモデル_261116")
assert.equal(event.visibility_type, "PUBLIC")
assert.equal(event.ranking_enabled, 1)
assert.equal(event.ratings, "G,R15")
assert.equal(event.start_at, "2026-11-16T00:00:00.000+00:00")
assert.equal(event.end_at, "2026-11-22T23:59:59.000+00:00")
const tags = await CORE.prepare("SELECT tag_name, is_primary FROM user_event_tags ORDER BY is_primary DESC").all<any>()
assert.deepEqual(tags.results.map((t: any) => [t.tag_name, t.is_primary]), [["ピックアップモデル_261116", 1], ["みんなのモデル", 0]])

const notes = await ACTIVITY.prepare("SELECT userId, workId, notifyType, comment FROM notifications").all<any>()
assert.equal(notes.results.length, 1)
assert.equal(notes.results[0].userId, 300)
assert.equal(notes.results[0].workId, 0)
assert.match(notes.results[0].comment, /人気のLoRA/)

// 2 回目の cron は何もしない（お知らせも重ねない）
const run2 = await p.runWeeklyPickup(deps)
assert.equal(run2.action, "kept")
assert.equal((await ACTIVITY.prepare("SELECT COUNT(*) AS n FROM notifications").first<any>()).n, 1)

// ---- 運営の差し替え ----
const replaced = await p.decidePickup(deps, { weekStart: "2026-11-16", modelId: "dddddddddddd", source: "ADMIN", decidedBy: "9" })
assert.equal(replaced.modelId, "dddddddddddd")
assert.equal(replaced.source, "ADMIN")
assert.match(replaced.xDraft.text, /そこそこのチェックポイント/)
assert.match(replaced.xDraft.text, /#ピックアップモデル_261116/)
assert.match(replaced.xDraft.text, /https:\/\/www\.aipictors\.com\/models\/u\/dddddddddddd/)
assert.ok(replaced.xDraft.text.length <= 280 * 2)
assert.deepEqual(replaced.xDraft.images, ["https://example.com/t.webp", "https://example.com/s1.webp", "https://example.com/s2.webp"])
assert.equal((await CORE.prepare("SELECT COUNT(*) AS n FROM user_events").first<any>()).n, 1)
assert.match((await CORE.prepare("SELECT title FROM user_events").first<any>()).title, /そこそこのチェックポイント/)
assert.equal((await ACTIVITY.prepare("SELECT COUNT(*) AS n FROM notifications WHERE userId = 400").first<any>()).n, 1)
// 運営が決めた週は cron で上書きしない
assert.equal((await p.runWeeklyPickup(deps)).action, "kept")

// R18 や存在しないモデルは差し替えでも選べるが、READY でないものは選べない
await assert.rejects(p.decidePickup(deps, { weekStart: "2026-11-16", modelId: "zzzzzzzzzzzz", source: "ADMIN" }), /使えるモデル/)
await assert.rejects(p.decidePickup(deps, { weekStart: "2026-11-17", modelId: "aaaaaaaaaaaa", source: "ADMIN" }), /月曜/)

// 翌週: 直近に選んだモデル・登録者は外れる
const nextDeps = { ...deps, now: NOW + 7 * 86400 }
const next = await p.listPickupCandidates(nextDeps)
const nextById = Object.fromEntries(next.map((c: any) => [c.modelId, c]))
assert.match(nextById.dddddddddddd.excludedReason, /直近8週/)
assert.equal(nextById.aaaaaaaaaaaa.excludedReason, null) // 差し替えで外れたモデルは翌週も候補に残る

// ---- 主催者への前日の参加数 ----
const digestMod = await import(`${API}/lib/user-event-digest.ts`)
for (const sql of [
  `CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, worksId INTEGER NOT NULL, category TEXT NOT NULL)`,
  `CREATE TABLE works (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, time TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
    viewMode INTEGER DEFAULT 0, adminViewMode INTEGER DEFAULT 0)`,
  `INSERT INTO user_events (user_id, slug, title, main_tag, visibility_type, ratings, start_at, end_at, created_at, updated_at)
   VALUES (500, 'neko-1', '猫の日', '猫の日お題', 'PUBLIC', 'G', '2026-11-10T00:00:00.000+00:00', '2026-11-30T23:59:00.000+00:00', '', ''),
          (501, 'old-1', '終わった', '終わったお題', 'PUBLIC', 'G', '2026-11-01T00:00:00.000+00:00', '2026-11-05T23:59:00.000+00:00', '', ''),
          (502, 'draft-1', '下書き', '下書きお題', 'DRAFT', 'G', '2026-11-10T00:00:00.000+00:00', '2026-11-30T23:59:00.000+00:00', '', '')`,
  // 昨日（11/17 JST）の投稿: 2 人から 3 件、主催者自身 1 件、非公開 1 件、今日 1 件
  `INSERT INTO works (id, userId, time, viewMode) VALUES (1, 600, '2026-11-17T09:00:00.000+00:00', 0), (2, 600, '2026-11-17T10:00:00.000+00:00', 1),
     (3, 601, '2026-11-17T23:00:00.000+00:00', 0), (4, 500, '2026-11-17T12:00:00.000+00:00', 0), (5, 602, '2026-11-17T12:00:00.000+00:00', 2),
     (6, 603, '2026-11-18T01:00:00.000+00:00', 0), (7, 604, '2026-11-17T12:00:00.000+00:00', 0)`,
  `INSERT INTO categories (worksId, category) VALUES (1, '猫の日お題'), (2, '猫の日お題'), (3, '猫の日お題'), (4, '猫の日お題'), (5, '猫の日お題'),
     (6, '猫の日お題'), (7, '下書きお題'), (7, '終わったお題')`,
]) {
  await CORE.prepare(sql).run()
}
const beforeDigest = (await ACTIVITY.prepare("SELECT COUNT(*) AS n FROM notifications").first<any>()).n
const digest = await digestMod.runUserEventDigest({ core: CORE, activity: ACTIVITY }, NOW)
assert.deepEqual(digest, { events: 1, notified: 1 })
const digestNote = await ACTIVITY.prepare("SELECT userId, comment FROM notifications ORDER BY id DESC LIMIT 1").first<any>()
assert.equal(digestNote.userId, 500)
assert.match(digestNote.comment, /猫の日」に、昨日 2 人から 3 件の参加/)
assert.match(digestNote.comment, /\/events\/neko-1/)
assert.equal((await ACTIVITY.prepare("SELECT COUNT(*) AS n FROM notifications").first<any>()).n, beforeDigest + 1)

await sys.dispose()
await d1.dispose()
console.log("user-model-pickups ok")
