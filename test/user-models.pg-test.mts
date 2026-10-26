// aipictors-api のユーザーモデル（アップロード・一覧・削除・ファイル配信）を本物の Postgres と簡易 R2 モックで検証する
import EmbeddedPostgres from "embedded-postgres"
import pg from "pg"
import assert from "node:assert/strict"
import { Hono } from "hono"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { schemaStatements } = await import(`${API}/lib/db.ts`)
const um = await import(`${API}/lib/user-models.ts`)
const { createUserModelsRoutes } = await import(`${API}/routes/user-models.ts`)

const dir = `/tmp/user-models-test-pg-${process.pid}`
const epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: 54331, persistent: false })
await epg.initialise()
await epg.start()
await epg.createDatabase("t")
const pool = new pg.Pool({ connectionString: "postgres://postgres:pw@127.0.0.1:54331/t", max: 40 })
pg.types.setTypeParser(20, (v) => Number(v))

const db = {
  async query(text: string, params: unknown[] = []) {
    return (await pool.query(text, params)).rows
  },
  async queryOne(text: string, params: unknown[] = []) {
    return (await pool.query(text, params)).rows[0] ?? null
  },
  async execute(text: string, params: unknown[] = []) {
    await pool.query(text, params)
  },
  async executeResult(text: string, params: unknown[] = []) {
    return { rowCount: (await pool.query(text, params)).rowCount ?? 0 }
  },
  async lockedQuery(keys: string[], text: string, params: unknown[] = []) {
    const c = await pool.connect()
    try {
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED")
      await c.query(
        `SELECT pg_advisory_xact_lock(h)
           FROM (SELECT DISTINCT hashtextextended(k, 0) AS h FROM unnest($1::text[]) AS k ORDER BY h) AS ordered`,
        [[...new Set(keys)]],
      )
      const r = await c.query(text, params)
      await c.query("COMMIT")
      return r.rows
    } catch (e) {
      await c.query("ROLLBACK")
      throw e
    } finally {
      c.release()
    }
  },
  async lockedQueryOne(keys: string[], text: string, params: unknown[] = []) {
    return (await this.lockedQuery(keys, text, params))[0] ?? null
  },
}
for (const s of schemaStatements) await db.execute(s)

// ---- 簡易 R2 モック ----
const readAll = async (value: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer) => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(await new Response(value).arrayBuffer())
}
class MockBucket {
  objects = new Map<string, Uint8Array>()
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>()
  aborted: string[] = []
  seq = 0
  async createMultipartUpload(key: string) {
    const uploadId = `up${++this.seq}`
    this.uploads.set(uploadId, { key, parts: new Map() })
    return { key, uploadId }
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const get = () => {
      const u = this.uploads.get(uploadId)
      if (!u || u.key !== key) throw new Error("NoSuchUpload")
      return u
    }
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, value: ReadableStream<Uint8Array>) => {
        const u = get()
        const bytes = await readAll(value)
        u.parts.set(partNumber, bytes)
        return { partNumber, etag: `etag-${partNumber}-${bytes.length}` }
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        const u = get()
        const chunks = parts.map((p) => {
          const b = u.parts.get(p.partNumber)
          if (!b || p.etag !== `etag-${p.partNumber}-${b.length}`) throw new Error("InvalidPart")
          return b
        })
        const total = chunks.reduce((n, b) => n + b.length, 0)
        const out = new Uint8Array(total)
        let o = 0
        for (const b of chunks) {
          out.set(b, o)
          o += b.length
        }
        this.objects.set(key, out)
        this.uploads.delete(uploadId)
        return { key, size: total, httpEtag: `"obj-${total}"` }
      },
      abort: async () => {
        this.uploads.delete(uploadId)
        this.aborted.push(uploadId)
      },
    }
  }
  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    const b = this.objects.get(key)
    if (!b) return null
    const slice = opts?.range ? b.subarray(opts.range.offset, opts.range.offset + opts.range.length) : b
    return { key, size: b.length, httpEtag: `"obj-${b.length}"`, body: new Blob([slice]).stream() }
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
}
const bucket = new MockBucket()

let fakeNow = Math.floor(Date.parse("2026-10-27T12:00:00+09:00") / 1000)
const TOKEN = "test-internal-token"
const app = new Hono()
app.route("/internal/user-models", createUserModelsRoutes(async () => ({ db, bucket, now: fakeNow })))
const env = { INTERNAL_API_TOKEN: TOKEN }

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } }
  if (body instanceof Uint8Array) {
    init.body = body
    ;(init.headers as Record<string, string>)["content-length"] = String(body.length)
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)["content-type"] = "application/json"
  }
  const res = await app.request(`/internal/user-models${path}`, init, env)
  return res
}
const callJson = async (method: string, path: string, body?: unknown) => {
  const res = await call(method, path, body)
  return { status: res.status, body: (await res.json()) as any }
}

// ---- テスト用 safetensors ----
const HEADER_LEN = 512
const makeSafetensors = (total: number, keys: string[] = ["lora_unet_down.lora_down.weight"], seed = 1) => {
  const dataLen = total - 8 - HEADER_LEN
  const per = Math.floor(dataLen / keys.length)
  const header: Record<string, unknown> = { __metadata__: { ss_network_module: "networks.lora" } }
  keys.forEach((k, i) => {
    header[k] = { dtype: "U8", shape: [per], data_offsets: [i * per, i === keys.length - 1 ? dataLen : (i + 1) * per] }
  })
  const json = JSON.stringify(header).padEnd(HEADER_LEN, " ")
  assert.equal(json.length, HEADER_LEN)
  const out = new Uint8Array(total)
  new DataView(out.buffer).setBigUint64(0, BigInt(HEADER_LEN), true)
  out.set(new TextEncoder().encode(json), 8)
  for (let i = 8 + HEADER_LEN; i < total; i += 4096) out[i] = (i * seed) & 0xff
  return out
}
const sha256Hex = async (bytes: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")

const PART = um.USER_MODEL_PART_SIZE

// アップロードを最後まで行う
const uploadAll = async (userId: string, file: Uint8Array, extra: Record<string, unknown> = {}) => {
  const sha256 = await sha256Hex(file)
  const start = await callJson("POST", "/uploads", {
    userId,
    kind: "LORA",
    filename: "my-lora.safetensors",
    sizeBytes: file.length,
    sha256,
    name: "テスト LoRA",
    ...extra,
  })
  if (start.status !== 200) return { start }
  const { modelId, partCount, status } = start.body.data
  if (status === "READY") return { start, modelId }
  const parts = []
  for (let n = 1; n <= partCount; n++) {
    const res = await call("PUT", `/uploads/${modelId}/parts/${n}?userId=${userId}`, file.subarray((n - 1) * PART, n * PART))
    const body = (await res.json()) as any
    assert.equal(res.status, 200, JSON.stringify(body))
    parts.push(body.data)
  }
  const complete = await callJson("POST", `/uploads/${modelId}/complete`, { userId, parts: parts.reverse() })
  return { start, modelId, complete, sha256 }
}

const addSub = (u: string, type: string) =>
  db.execute(
    `INSERT INTO subscriptions(nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
     VALUES ($1, $2, $3, 'paid', FALSE, $4, $4, $5, $1)`,
    [`sub_${u}_${type}`, u, type, fakeNow - 86400, fakeNow + 30 * 86400],
  )

let passed = 0
const t = async (name: string, fn: () => Promise<void>) => {
  await fn()
  passed++
  console.log(`ok  ${name}`)
}

const bigFile = makeSafetensors(2 * PART + 12345)
let bigId = ""
let bigSha = ""

await t("トークンなしは 401", async () => {
  const res = await app.request("/internal/user-models", {}, env)
  assert.equal(res.status, 401)
})

await t("3 パート（50MB, 50MB, 端数）のアップロードが完了して READY になる", async () => {
  const r = await uploadAll("a1", bigFile)
  assert.equal(r.start.body.data.partCount, 3)
  assert.equal(r.start.body.data.partSize, PART)
  assert.equal(r.complete!.status, 200, JSON.stringify(r.complete!.body))
  assert.equal(r.complete!.body.data.status, "READY")
  bigId = r.modelId!
  bigSha = r.sha256!
  assert.match(bigId, /^[0-9a-z]{12}$/)
  assert.deepEqual(bucket.objects.get(`models/${bigSha}.safetensors`), bigFile)
  const got = await callJson("GET", `/${bigId}`)
  assert.equal(got.body.data.status, "READY")
  assert.equal(got.body.data.sizeBytes, bigFile.length)
  assert.equal(got.body.data.loraName, `user_${bigId}`)
  assert.equal(got.body.data.promptSyntax, `<lora:user_${bigId}:0.8>`)
})

await t("ファイル配信: 全体と Range（a-b / a- / -n）、不正な Range は 416", async () => {
  const full = await call("GET", `/${bigId}/file`)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get("content-length"), String(bigFile.length))
  assert.equal(full.headers.get("x-model-sha256"), bigSha)
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bigFile)
  const part = await call("GET", `/${bigId}/file`, undefined, { range: "bytes=100-199" })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get("content-range"), `bytes 100-199/${bigFile.length}`)
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bigFile.subarray(100, 200))
  const open = await call("GET", `/${bigId}/file`, undefined, { range: `bytes=${bigFile.length - 10}-` })
  assert.equal((await open.arrayBuffer()).byteLength, 10)
  const suffix = await call("GET", `/${bigId}/file`, undefined, { range: "bytes=-20" })
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bigFile.subarray(bigFile.length - 20))
  const bad = await call("GET", `/${bigId}/file`, undefined, { range: `bytes=${bigFile.length}-` })
  assert.equal(bad.status, 416)
})

await t("無料プランは 1 個まで。2 個目は LIMIT_EXCEEDED", async () => {
  const r = await uploadAll("a1", makeSafetensors(1000, undefined, 2))
  assert.equal(r.start.status, 409)
  assert.equal(r.start.body.code, "LIMIT_EXCEEDED")
})

await t("同じユーザが同じファイルを 2 回登録しようとすると ALREADY_REGISTERED", async () => {
  await db.execute("INSERT INTO pricing_settings(key, value, updated_at) VALUES ('user_models.limit.FREE', '5', 0)")
  const r = await uploadAll("a1", bigFile)
  assert.equal(r.start.status, 409)
  assert.equal(r.start.body.code, "ALREADY_REGISTERED")
  await db.execute("DELETE FROM pricing_settings WHERE key = 'user_models.limit.FREE'")
})

await t("pricing_settings で上限を上書きでき、契約者はプランの上限（LITE 3）", async () => {
  await addSub("a2", "LITE")
  const mine = await callJson("GET", "/mine/a2")
  assert.equal(mine.body.data.limit, 3)
  assert.equal(mine.body.data.planType, "LITE")
  await db.execute("INSERT INTO pricing_settings(key, value, updated_at) VALUES ('user_models.limit.LITE', '4', 0)")
  assert.equal((await callJson("GET", "/mine/a2")).body.data.limit, 4)
  await db.execute("DELETE FROM pricing_settings WHERE key = 'user_models.limit.LITE'")
})

await t("同じ sha256 の READY があれば他のユーザは即 READY（重複排除）", async () => {
  const r = await uploadAll("a2", bigFile, { name: "コピー" })
  assert.equal(r.start.status, 200)
  assert.equal(r.start.body.data.status, "READY")
  assert.equal(r.start.body.data.deduplicated, true)
  assert.equal(r.start.body.data.model.userId, "a2")
  const rows = await db.query("SELECT DISTINCT r2_key FROM user_models WHERE sha256 = $1", [bigSha])
  assert.equal(rows.length, 1)
})

await t("サイズが違う同 sha256 は SIZE_MISMATCH", async () => {
  const r = await callJson("POST", "/uploads", {
    userId: "a3", kind: "LORA", filename: "x.safetensors", sizeBytes: 999, sha256: bigSha, name: "x",
  })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, "SIZE_MISMATCH")
})

await t("拡張子・サイズ上限・sha256 の形式をチェックする", async () => {
  const base = { userId: "a3", kind: "LORA", sizeBytes: 1000, sha256: "a".repeat(64), name: "x" }
  assert.equal((await callJson("POST", "/uploads", { ...base, filename: "x.ckpt" })).body.code, "INVALID_EXTENSION")
  assert.equal(
    (await callJson("POST", "/uploads", { ...base, filename: "x.safetensors", sizeBytes: 401 * 1024 * 1024 })).body.code,
    "TOO_LARGE",
  )
  const ckpt = await callJson("POST", "/uploads", {
    ...base, kind: "CHECKPOINT", filename: "x.safetensors", sizeBytes: 401 * 1024 * 1024, sha256: "b".repeat(64),
  })
  assert.equal(ckpt.status, 200)
  assert.equal(ckpt.body.data.partCount, 9)
  await callJson("POST", `/uploads/${ckpt.body.data.modelId}/abort`, { userId: "a3" })
  assert.equal((await callJson("POST", "/uploads", { ...base, filename: "x.safetensors", sha256: "xyz" })).body.code, "INVALID_INPUT")
})

await t("safetensors でないファイルは最初のパートで拒否し、アップロードを破棄する", async () => {
  const junk = new Uint8Array(3000).fill(0x41)
  const sha256 = await sha256Hex(junk)
  const start = await callJson("POST", "/uploads", {
    userId: "a4", kind: "LORA", filename: "fake.safetensors", sizeBytes: junk.length, sha256, name: "fake",
  })
  const { modelId, uploadId } = start.body.data
  const res = await call("PUT", `/uploads/${modelId}/parts/1`, junk)
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as any).code, "INVALID_SAFETENSORS")
  assert.ok(bucket.aborted.includes(uploadId))
  const row = await db.queryOne("SELECT status FROM user_models WHERE id = $1", [modelId])
  assert.equal(row.status, "DELETED")
  assert.equal((await callJson("GET", "/mine/a4")).body.data.used, 0)
})

await t("ヘッダーのサイズと申告サイズが違う・LoRA にチェックポイント、は拒否", async () => {
  const file = makeSafetensors(5000)
  const start = await callJson("POST", "/uploads", {
    userId: "a5", kind: "LORA", filename: "a.safetensors", sizeBytes: 5001, sha256: await sha256Hex(file), name: "a",
  })
  const padded = new Uint8Array(5001)
  padded.set(file)
  const res = await call("PUT", `/uploads/${start.body.data.modelId}/parts/1`, padded)
  assert.equal(((await res.json()) as any).code, "INVALID_SAFETENSORS")

  const ckpt = makeSafetensors(6000, ["model.diffusion_model.input_blocks.0.weight", "first_stage_model.decoder.weight"])
  const s2 = await callJson("POST", "/uploads", {
    userId: "a5", kind: "LORA", filename: "c.safetensors", sizeBytes: ckpt.length, sha256: await sha256Hex(ckpt), name: "c",
  })
  const r2 = await call("PUT", `/uploads/${s2.body.data.modelId}/parts/1`, ckpt)
  assert.equal(((await r2.json()) as any).code, "KIND_MISMATCH")
})

await t("パートのサイズ違い・範囲外の partNumber・欠けた parts での complete は拒否", async () => {
  const file = makeSafetensors(PART + 100, undefined, 3)
  const start = await callJson("POST", "/uploads", {
    userId: "a6", kind: "LORA", filename: "p.safetensors", sizeBytes: file.length, sha256: await sha256Hex(file), name: "p",
  })
  const id = start.body.data.modelId
  assert.equal((await call("PUT", `/uploads/${id}/parts/1`, file.subarray(0, 1000))).status, 400)
  assert.equal((await call("PUT", `/uploads/${id}/parts/3`, file.subarray(0, 100))).status, 400)
  assert.equal((await call("PUT", `/uploads/${id}/parts/2?userId=someone`, file.subarray(PART))).status, 403)
  const p2 = (await (await call("PUT", `/uploads/${id}/parts/2`, file.subarray(PART))).json()) as any
  const c = await callJson("POST", `/uploads/${id}/complete`, { parts: [p2.data] })
  assert.equal(c.body.code, "INVALID_PARTS")
  await callJson("POST", `/uploads/${id}/abort`, {})
})

await t("無料ユーザが 10 並列でアップロードを始めても 1 個だけ通る", async () => {
  const rs = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      callJson("POST", "/uploads", {
        userId: "a7", kind: "LORA", filename: "x.safetensors", sizeBytes: 1000,
        sha256: (i + 1).toString(16).padStart(64, "c"), name: `x${i}`,
      }),
    ),
  )
  assert.equal(rs.filter((r) => r.status === 200).length, 1)
  assert.equal(rs.filter((r) => r.body.code === "LIMIT_EXCEEDED").length, 9)
})

await t("24 時間放置されたアップロードは次のアップロード開始時に破棄される", async () => {
  fakeNow += 25 * 3600
  const file = makeSafetensors(2000, undefined, 4)
  const r = await uploadAll("a7", file)
  assert.equal(r.complete!.body.data.status, "READY")
  const mine = await callJson("GET", "/mine/a7")
  assert.equal(mine.body.data.used, 1)
})

await t("一覧: READY のみ、kind / q / ratings / tag / 人気順・新着順", async () => {
  await addSub("a8", "PREMIUM")
  const ckpt = makeSafetensors(4000, ["model.diffusion_model.out.weight"], 5)
  const c = await uploadAll("a8", ckpt, { kind: "CHECKPOINT", name: "Anime Mix", baseModel: "SDXL", rating: "R18", tags: ["anime", "mix"] })
  const ckptId = c.modelId!
  fakeNow += 10
  const l = await uploadAll("a8", makeSafetensors(3000, undefined, 6), { name: "Watercolor 100%", tags: ["paint"] })
  for (let i = 0; i < 3; i++) assert.equal((await callJson("POST", `/${ckptId}/used`, {})).status, 200)
  const all = await callJson("GET", "?sort=popular")
  assert.equal(all.body.data.models[0].id, ckptId)
  assert.equal(all.body.data.models[0].useCount, 3)
  assert.ok(all.body.data.models.every((m: any) => m.status === "READY"))
  const newest = await callJson("GET", "?sort=new&limit=1")
  assert.equal(newest.body.data.models[0].id, l.modelId)
  assert.equal(newest.body.data.models.length, 1)
  assert.ok(newest.body.data.totalCount >= 4)
  const ck = await callJson("GET", "?kind=CHECKPOINT")
  assert.deepEqual(ck.body.data.models.map((m: any) => m.id), [ckptId])
  assert.equal(ck.body.data.models[0].generationModel, `user/${ckptId}.safetensors`)
  assert.equal((await callJson("GET", "?ratings=G,R15&kind=CHECKPOINT")).body.data.models.length, 0)
  assert.equal((await callJson("GET", "?q=anime")).body.data.models[0].id, ckptId)
  assert.equal((await callJson("GET", "?q=100%25")).body.data.models[0].id, l.modelId)
  assert.equal((await callJson("GET", "?tag=paint")).body.data.models[0].id, l.modelId)
  assert.equal((await callJson("GET", "?baseModel=SDXL")).body.data.totalCount, 1)
  assert.equal((await callJson("GET", "?ratings=XX")).status, 400)
})

await t("PATCH は作者のみ。サムネイルを消せる", async () => {
  const other = await callJson("PATCH", `/${bigId}`, { userId: "a2", name: "乗っ取り" })
  assert.equal(other.status, 403)
  const ok = await callJson("PATCH", `/${bigId}`, {
    userId: "a1", name: "新しい名前", thumbnailUrl: "https://example.com/t.png", tags: ["a", "a", "b"], recommendedWeight: 0.65,
  })
  assert.equal(ok.body.data.name, "新しい名前")
  assert.deepEqual(ok.body.data.tags, ["a", "b"])
  assert.equal(ok.body.data.promptSyntax, `<lora:user_${bigId}:0.65>`)
  const cleared = await callJson("PATCH", `/${bigId}`, { userId: "a1", thumbnailUrl: null })
  assert.equal(cleared.body.data.thumbnailUrl, null)
  assert.equal(cleared.body.data.name, "新しい名前")
  assert.equal((await callJson("PATCH", `/${bigId}`, { userId: "a1", thumbnailUrl: "http://x" })).status, 400)
})

await t("GPU 側の sha256 が不一致なら同じファイルの READY をすべて DISABLED に", async () => {
  const file = makeSafetensors(2500, undefined, 7)
  await addSub("a9", "STANDARD")
  const r = await uploadAll("a9", file)
  const dup = await uploadAll("a8", file, { name: "dup" })
  const okRes = await callJson("POST", `/${r.modelId}/verify`, { sha256: r.sha256 })
  assert.equal(okRes.body.data.ok, true)
  const bad = await callJson("POST", `/${r.modelId}/verify`, { sha256: "d".repeat(64) })
  assert.equal(bad.body.data.disabledCount, 2)
  assert.equal((await callJson("GET", `/${dup.modelId}`)).body.data.status, "DISABLED")
  assert.equal((await call("GET", `/${r.modelId}/file`)).status, 409)
})

await t("削除: 他人は 403。参照が残る間は R2 に残し、0 になったら消す", async () => {
  const key = `models/${bigSha}.safetensors`
  const a2Model = (await db.queryOne("SELECT id FROM user_models WHERE user_id = 'a2' AND sha256 = $1", [bigSha])).id
  assert.equal((await callJson("DELETE", `/${bigId}`, { userId: "a2" })).status, 403)
  const d1 = await callJson("DELETE", `/${bigId}`, { userId: "a1" })
  assert.equal(d1.body.data.fileDeleted, false)
  assert.ok(bucket.objects.has(key))
  assert.equal((await callJson("GET", `/${bigId}`)).status, 404)
  const d2 = await call("DELETE", `/${a2Model}?userId=a2`)
  assert.equal(((await d2.json()) as any).data.fileDeleted, true)
  assert.ok(!bucket.objects.has(key))
  assert.equal((await callJson("GET", "/mine/a1")).body.data.used, 0)
})

await t("通報: 5 人で自動非表示、管理者が戻すと解決済み。無効化 API は単体だけ止める", async () => {
  const file = makeSafetensors(2600, undefined, 11)
  await addSub("r0", "STANDARD")
  const m = await uploadAll("r0", file, { name: "report-target" })
  assert.equal((await callJson("POST", `/${m.modelId}/report`, { userId: "r0", reason: "SPAM" })).status, 400)
  assert.equal((await callJson("POST", `/${m.modelId}/report`, { userId: "r1" })).status, 400)
  for (const u of ["r1", "r1", "r2", "r3", "r4"]) {
    const res = await callJson("POST", `/${m.modelId}/report`, { userId: u, reason: "COPYRIGHT" })
    assert.equal(res.body.data.autoHidden, false)
  }
  const fifth = await callJson("POST", `/${m.modelId}/report`, { userId: "r5", reason: "REAL_PERSON", detail: "x" })
  assert.equal(fifth.body.data.openReports, 5)
  assert.equal(fifth.body.data.autoHidden, true)
  const reports = await callJson("GET", "/reports")
  const entry = reports.body.data.reports.find((r: any) => r.model.id === m.modelId)
  assert.equal(entry.reportCount, 5)
  assert.deepEqual(entry.reasons.sort(), ["COPYRIGHT", "REAL_PERSON"])
  const enabled = await callJson("POST", `/${m.modelId}/enable`, {})
  assert.equal(enabled.body.data.status, "READY")
  assert.ok(!(await callJson("GET", "/reports")).body.data.reports.some((r: any) => r.model.id === m.modelId))
  const dup = await uploadAll("r1", file, { name: "same-file" })
  const dis = await callJson("POST", `/${m.modelId}/disable`, { reason: "admin: copyright" })
  assert.equal(dis.body.data.disabledCount, 1)
  assert.equal((await callJson("GET", `/${dup.modelId}`)).body.data.status, "READY")
  const sha = await callJson("POST", `/${dup.modelId}/disable`, { reason: "sha256_mismatch" })
  assert.equal(sha.body.data.disabledCount, 1)
  assert.equal((await callJson("GET", `/${dup.modelId}`)).body.data.status, "DISABLED")
})

await t("一覧は hasMore を返す", async () => {
  const page = await callJson("GET", "?limit=1")
  assert.equal(typeof page.body.data.hasMore, "boolean")
})

await t("used / file は存在しない ID で 404", async () => {
  assert.equal((await callJson("POST", "/zzzzzzzzzzzz/used", {})).status, 404)
  assert.equal((await call("GET", "/not-an-id/file")).status, 404)
})


// ---- URL（Civitai）からの取り込み ----
const imp = await import(`${API}/lib/user-model-imports.ts`)

await t("Civitai の URL を読める（モデルページ / slug / modelVersionId / download URL）。他サイトは UNSUPPORTED_URL", async () => {
  assert.deepEqual(imp.parseCivitaiUrl("https://civitai.com/models/123"), { modelId: 123, versionId: null })
  assert.deepEqual(imp.parseCivitaiUrl("https://civitai.com/models/123/cute-style?modelVersionId=456"), { modelId: 123, versionId: 456 })
  assert.deepEqual(imp.parseCivitaiUrl(" civitai.com/models/123/x/ "), { modelId: 123, versionId: null })
  assert.deepEqual(imp.parseCivitaiUrl("https://civitai.com/api/download/models/456?type=Model"), { modelId: null, versionId: 456 })
  assert.throws(() => imp.parseCivitaiUrl("https://huggingface.co/x/y"), (e: any) => e.code === "UNSUPPORTED_URL")
  assert.throws(() => imp.parseCivitaiUrl("https://civitai.com/images/1"), (e: any) => e.code === "UNSUPPORTED_URL")
  assert.throws(() => imp.parseCivitaiUrl(""), (e: any) => e.code === "INVALID_INPUT")
})

await t("系統・ライセンス・画像 URL の変換", async () => {
  assert.equal(imp.mapCivitaiBaseModel("SD 1.5"), "SD1.5")
  assert.equal(imp.mapCivitaiBaseModel("SDXL 1.0"), "SDXL")
  assert.equal(imp.mapCivitaiBaseModel("Pony"), "PONY")
  assert.equal(imp.mapCivitaiBaseModel("Illustrious"), "ILLUSTRIOUS")
  assert.equal(imp.mapCivitaiBaseModel("NoobAI"), "NOOBAI")
  for (const other of ["Anima", "Flux.1 D", "SD 3.5", "", undefined]) assert.equal(imp.mapCivitaiBaseModel(other), "OTHER")
  assert.deepEqual(imp.normalizeCivitaiLicense({ allowCommercialUse: "Rent" } as any).allowCommercialUse, ["Image", "RentCivit", "Rent"])
  assert.deepEqual(imp.normalizeCivitaiLicense({ allowCommercialUse: "None" } as any).allowCommercialUse, [])
  assert.equal(
    imp.civitaiImageUrl("https://image.civitai.com/abc/uuid-1/width=832/1.jpeg", 450),
    "https://image.civitai.com/abc/uuid-1/width=450/1.jpeg",
  )
  assert.equal(
    imp.civitaiImageUrl("https://image.civitai.com/abc/uuid-1/original=true/1.jpeg", 450),
    "https://image.civitai.com/abc/uuid-1/width=450/1.jpeg",
  )
  assert.equal(imp.htmlToText("<p>Hello&nbsp;<b>world</b></p><ul><li>a</li></ul>"), "Hello world\n・a")
})

// 偽の Civitai（API・ダウンロードの 307・署名付き URL の Range）
type FakeModel = { model: any; file: Uint8Array; loginRequired?: boolean }
const civitai = {
  models: new Map<number, FakeModel>(),
  fetched: [] as string[],
  expireSig: new Set<string>(),
  resolveCount: 0,
  rangeStatusOverride: null as number | null,
}
const fakeFetch = async (input: string, init: RequestInit = {}) => {
  civitai.fetched.push(input)
  const url = new URL(input)
  const headers = new Headers(init.headers)
  let m = /^\/api\/v1\/models\/(\d+)$/.exec(url.pathname)
  if (url.hostname === "civitai.com" && m) {
    const entry = civitai.models.get(Number(m[1]))
    return entry ? Response.json(entry.model) : new Response("not found", { status: 404 })
  }
  m = /^\/api\/v1\/model-versions\/(\d+)$/.exec(url.pathname)
  if (url.hostname === "civitai.com" && m) {
    for (const entry of civitai.models.values()) {
      const v = entry.model.modelVersions.find((v: any) => v.id === Number(m![1]))
      if (v) return Response.json({ ...v, modelId: entry.model.id })
    }
    return new Response("not found", { status: 404 })
  }
  m = /^\/api\/download\/models\/(\d+)$/.exec(url.pathname)
  if (url.hostname === "civitai.com" && m) {
    assert.equal(init.redirect, "manual")
    for (const entry of civitai.models.values()) {
      if (!entry.model.modelVersions.some((v: any) => v.id === Number(m![1]))) continue
      if (entry.loginRequired && headers.get("authorization") !== "Bearer civ-token") return new Response("{}", { status: 401 })
      civitai.resolveCount++
      return new Response(null, { status: 307, headers: { location: `https://signed.example/v${m[1]}?sig=${civitai.resolveCount}` } })
    }
    return new Response("not found", { status: 404 })
  }
  m = /^\/v(\d+)$/.exec(url.pathname)
  if (url.hostname === "signed.example" && m) {
    if (civitai.expireSig.has(url.searchParams.get("sig")!)) return new Response("expired", { status: 403 })
    if (civitai.rangeStatusOverride) return new Response("x", { status: civitai.rangeStatusOverride })
    const entry = [...civitai.models.values()].find((e) => e.model.modelVersions.some((v: any) => v.id === Number(m![1])))!
    const r = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "")!
    const start = Number(r[1])
    const end = Math.min(Number(r[2]), entry.file.length - 1)
    return new Response(entry.file.slice(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${entry.file.length}`, "content-length": String(end - start + 1) },
    })
  }
  throw new Error(`unexpected fetch ${input}`)
}

const addCivitaiModel = async (opts: {
  id: number
  versionId: number
  type?: string
  baseModel?: string
  nsfw?: boolean
  file: Uint8Array
  loginRequired?: boolean
  allowCommercialUse?: unknown
  name?: string
}) => {
  const sha = (await sha256Hex(opts.file)).toUpperCase()
  civitai.models.set(opts.id, {
    file: opts.file,
    loginRequired: opts.loginRequired,
    model: {
      id: opts.id,
      name: opts.name ?? `Model ${opts.id}`,
      description: "<p>かわいい<b>スタイル</b>の LoRA です&amp;</p>",
      type: opts.type ?? "LORA",
      nsfw: opts.nsfw ?? false,
      tags: ["style", "anime"],
      creator: { username: "alice" },
      allowNoCredit: false,
      allowCommercialUse: opts.allowCommercialUse ?? ["Image", "RentCivit"],
      allowDerivatives: true,
      allowDifferentLicense: false,
      modelVersions: [
        {
          id: opts.versionId,
          name: "v2.0",
          baseModel: opts.baseModel ?? "Illustrious",
          trainedWords: ["cutestyle", "pastel"],
          images: [
            { url: "https://image.civitai.com/k/nsfw-1/width=832/1.jpeg", nsfwLevel: 8, type: "image" },
            { url: "https://image.civitai.com/k/safe-1/width=832/2.jpeg", nsfwLevel: 1, type: "image" },
            { url: "https://image.civitai.com/k/vid-1/width=832/3.mp4", nsfwLevel: 1, type: "video" },
          ],
          files: [
            { name: "train.zip", type: "Training Data", sizeKB: 10, downloadUrl: `https://civitai.com/api/download/models/${opts.versionId}?type=Training%20Data` },
            {
              name: `model-${opts.id}.safetensors`,
              type: "Model",
              primary: true,
              sizeKB: opts.file.length / 1024,
              metadata: { format: "SafeTensor" },
              hashes: { SHA256: sha, AutoV2: "abc" },
              downloadUrl: `https://civitai.com/api/download/models/${opts.versionId}`,
            },
          ],
        },
        { id: opts.versionId - 1, name: "v1.0", baseModel: "SD 1.5", files: [], images: [] },
      ],
    },
  })
  return sha.toLowerCase()
}

const startedImports: any[] = []
let workflowEnabled = true
const importApp = new Hono()
importApp.route(
  "/internal/user-models",
  createUserModelsRoutes(
    async () => ({ db, bucket, now: fakeNow }),
    () => ({
      fetch: fakeFetch,
      civitaiToken: null,
      startWorkflow: workflowEnabled
        ? async (params: any) => {
            startedImports.push(params)
          }
        : null,
    }),
  ),
)
const icall = async (method: string, path: string, body?: unknown) => {
  const res = await importApp.request(
    `/internal/user-models${path}`,
    {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
  return { status: res.status, body: (await res.json()) as any }
}
// 偽の step.do: 失敗したら再試行する（ImportFatalError は再試行しない）
const fakeStep = {
  names: [] as string[],
  async do(name: string, _config: unknown, cb: () => Promise<any>) {
    this.names.push(name)
    for (let attempt = 1; ; attempt++) {
      try {
        return await cb()
      } catch (e) {
        if (e instanceof imp.ImportFatalError || attempt >= 3) throw e
      }
    }
  },
}
const importDeps = async () => ({ db, bucket, now: fakeNow, fetch: fakeFetch, civitaiToken: null })
const runImport = (params: any) => imp.runUserModelImport(params, fakeStep, importDeps)

const civFile = makeSafetensors(2 * PART + 777, ["lora_unet_a.lora_down.weight", "lora_unet_a.lora_up.weight"], 7)
let civSha = ""

await t("preview: 種類・系統・ライセンス・サムネイル・説明（クレジット付き）を返し、副作用がない", async () => {
  civSha = await addCivitaiModel({ id: 100, versionId: 201, file: civFile, nsfw: true })
  const before = await db.queryOne("SELECT COUNT(*)::int AS n FROM user_models")
  const r = await icall("POST", "/imports/preview", { url: "https://civitai.com/models/100/cute" })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const p = r.body.data
  assert.equal(p.kind, "LORA")
  assert.equal(p.name, "Model 100 v2.0")
  assert.equal(p.baseModel, "ILLUSTRIOUS")
  assert.equal(p.sourceBaseModel, "Illustrious")
  assert.equal(p.baseModelSupported, true)
  assert.equal(p.rating, "R18")
  assert.equal(p.sha256, civSha)
  assert.equal(p.sizeBytes, civFile.length)
  assert.equal(p.creator, "alice")
  assert.equal(p.triggerWords, "cutestyle, pastel")
  assert.deepEqual(p.tags, ["style", "anime"])
  assert.equal(p.thumbnailUrl, "https://image.civitai.com/k/safe-1/width=450/2.jpeg")
  assert.deepEqual(p.sampleImageUrls, ["https://image.civitai.com/k/safe-1/width=1024/2.jpeg"])
  assert.equal(p.licenseAllowsOtherServices, false)
  assert.deepEqual(p.license.allowCommercialUse, ["Image", "RentCivit"])
  assert.equal(p.sourceUrl, "https://civitai.com/models/100?modelVersionId=201")
  assert.match(p.description, /^かわいいスタイルの LoRA です&\n\n元のモデル: https:\/\/civitai\.com\/models\/100\?modelVersionId=201\n作者: alice$/)
  assert.equal(p.downloadUrl, undefined)
  assert.equal(p.alreadyStored, false)
  const after = await db.queryOne("SELECT COUNT(*)::int AS n FROM user_models")
  assert.equal(after.n, before.n)
  // バージョン指定・download URL からも引ける
  const byVersion = await icall("POST", "/imports/preview", { url: "https://civitai.com/api/download/models/201" })
  assert.equal(byVersion.body.data.civitaiVersionId, 201)
  const old = await icall("POST", "/imports/preview", { url: "https://civitai.com/models/100?modelVersionId=200" })
  assert.equal(old.body.code, "UNSUPPORTED_FORMAT")
  assert.equal((await icall("POST", "/imports/preview", { url: "https://civitai.com/models/999" })).body.code, "SOURCE_NOT_FOUND")
})

let importedId = ""
await t("取り込み: QUEUED → Workflow で 3 パート転送（途中で署名切れ→解決し直し）→ READY。出典が付く", async () => {
  const r = await icall("POST", "/imports", { userId: "imp1", url: "https://civitai.com/models/100", name: "かわいい LoRA" })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.status, "QUEUED")
  assert.equal(r.body.data.deduplicated, false)
  importedId = r.body.data.modelId
  assert.deepEqual(startedImports.at(-1), { modelId: importedId, downloadUrl: "https://civitai.com/api/download/models/201" })
  const queued = await icall("GET", `/imports/${importedId}?userId=imp1`)
  assert.equal(queued.body.data.status, "QUEUED")
  assert.equal((await icall("GET", `/imports/${importedId}?userId=other`)).status, 404)
  // 進行中も上限に数える
  const mine = await callJson("GET", "/mine/imp1")
  assert.equal(mine.body.data.used, 1)

  // 2 つ目のパートの取得前に署名付き URL を切らす
  const origPart = imp.importStepPart
  let resolvesBefore = 0
  civitai.expireSig.clear()
  fakeStep.names = []
  const result = await imp.runUserModelImport(startedImports.at(-1), {
    async do(name: string, config: unknown, cb: () => Promise<any>) {
      if (name === "part-2") {
        resolvesBefore = civitai.resolveCount
        for (let i = 1; i <= resolvesBefore; i++) civitai.expireSig.add(String(i))
      }
      return fakeStep.do(name, config, cb)
    },
  }, importDeps)
  assert.equal(origPart, imp.importStepPart)
  assert.equal(result.status, "READY", JSON.stringify(result))
  assert.deepEqual(fakeStep.names, ["start", "part-1", "part-2", "part-3", "complete"])
  assert.equal(civitai.resolveCount, resolvesBefore + 1)
  assert.deepEqual(bucket.objects.get(`models/${civSha}.safetensors`), civFile)
  const done = await icall("GET", `/imports/${importedId}?userId=imp1`)
  assert.equal(done.body.data.status, "READY")
  assert.equal(done.body.data.partsDone, 3)
  assert.equal(done.body.data.partsTotal, 3)
  const model = done.body.data.model
  assert.equal(model.name, "かわいい LoRA")
  assert.equal(model.rating, "R18")
  assert.equal(model.sizeBytes, civFile.length)
  assert.equal(model.sourceUrl, "https://civitai.com/models/100?modelVersionId=201")
  assert.equal(model.sourceCreator, "alice")
  assert.equal(model.sourceBaseModel, "Illustrious")
  assert.equal(model.sourceLicenseAllowsOtherServices, false)
  assert.equal(model.sourceLicense.allowDerivatives, true)
  assert.equal(model.thumbnailUrl, "https://image.civitai.com/k/safe-1/width=450/2.jpeg")
  civitai.expireSig.clear()
})

await t("取り込み: 同じファイルが保存済みなら転送せずに即 READY（重複排除）。rating を指定できる", async () => {
  const before = startedImports.length
  const preview = await icall("POST", "/imports/preview", { url: "https://civitai.com/models/100" })
  assert.equal(preview.body.data.alreadyStored, true)
  const r = await icall("POST", "/imports", { userId: "imp2", url: "https://civitai.com/models/100", rating: "R15" })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.deduplicated, true)
  assert.equal(r.body.data.status, "READY")
  assert.equal(r.body.data.model.rating, "R15")
  assert.equal(r.body.data.model.sourceCreator, "alice")
  assert.equal(startedImports.length, before)
  // 同じユーザーがもう一度 → ALREADY_REGISTERED
  assert.equal((await icall("POST", "/imports", { userId: "imp2", url: "https://civitai.com/models/100" })).body.code, "ALREADY_REGISTERED")
})

await t("取り込み: 上限（進行中も数える）・ログインが必要・未対応の種類・Workflow なし", async () => {
  const f2 = makeSafetensors(5000, undefined, 11)
  await addCivitaiModel({ id: 110, versionId: 211, file: f2 })
  const first = await icall("POST", "/imports", { userId: "imp3", url: "https://civitai.com/models/110" })
  assert.equal(first.body.data.status, "QUEUED")
  const f3 = makeSafetensors(6000, undefined, 12)
  await addCivitaiModel({ id: 120, versionId: 221, file: f3 })
  const second = await icall("POST", "/imports", { userId: "imp3", url: "https://civitai.com/models/120" })
  assert.equal(second.status, 409)
  assert.equal(second.body.code, "LIMIT_EXCEEDED")

  await addCivitaiModel({ id: 130, versionId: 231, file: makeSafetensors(7000, undefined, 13), loginRequired: true })
  const rowsBefore = (await db.queryOne("SELECT COUNT(*)::int AS n FROM user_models")).n
  const login = await icall("POST", "/imports", { userId: "imp4", url: "https://civitai.com/models/130" })
  assert.equal(login.status, 400)
  assert.equal(login.body.code, "LOGIN_REQUIRED")
  assert.equal(login.body.error, "このモデルは Civitai のログインが必要なため、今は取り込めません")
  assert.equal((await db.queryOne("SELECT COUNT(*)::int AS n FROM user_models")).n, rowsBefore)
  // API キーがあれば解決できる
  const url = await imp.resolveCivitaiDownload({ fetch: fakeFetch, civitaiToken: "civ-token" }, "https://civitai.com/api/download/models/231")
  assert.match(url, /^https:\/\/signed\.example\/v231\?sig=\d+$/)

  await addCivitaiModel({ id: 140, versionId: 241, file: makeSafetensors(8000, undefined, 14), type: "TextualInversion" })
  assert.equal((await icall("POST", "/imports/preview", { url: "https://civitai.com/models/140" })).body.code, "UNSUPPORTED_TYPE")

  workflowEnabled = false
  assert.equal((await icall("POST", "/imports", { userId: "imp5", url: "https://civitai.com/models/120" })).status, 503)
  workflowEnabled = true
})

await t("未対応の系統（Flux）は OTHER で取り込み、種類違いのキーでも止めない。SDXL で種類違いは失敗→枠を空ける", async () => {
  // チェックポイントとして登録されているが中身は LoRA のキー
  const flux = makeSafetensors(9000, ["lora_unet_x.lora_down.weight"], 15)
  await addCivitaiModel({ id: 150, versionId: 251, file: flux, type: "Checkpoint", baseModel: "Flux.1 D", allowCommercialUse: ["Image", "Rent", "Sell"] })
  const preview = await icall("POST", "/imports/preview", { url: "https://civitai.com/models/150" })
  assert.equal(preview.body.data.kind, "CHECKPOINT")
  assert.equal(preview.body.data.baseModel, "OTHER")
  assert.equal(preview.body.data.sourceBaseModel, "Flux.1 D")
  assert.equal(preview.body.data.baseModelSupported, false)
  assert.equal(preview.body.data.licenseAllowsOtherServices, true)
  const r = await icall("POST", "/imports", { userId: "imp6", url: "https://civitai.com/models/150" })
  assert.equal(r.body.data.model.baseModel, "OTHER")
  const result = await runImport(startedImports.at(-1))
  assert.equal(result.status, "READY", JSON.stringify(result))

  const sdxl = makeSafetensors(9500, ["lora_unet_y.lora_down.weight"], 16)
  await addCivitaiModel({ id: 160, versionId: 261, file: sdxl, type: "Checkpoint", baseModel: "SDXL 1.0" })
  const r2 = await icall("POST", "/imports", { userId: "imp7", url: "https://civitai.com/models/160" })
  const failed = await runImport(startedImports.at(-1))
  assert.equal(failed.status, "FAILED")
  const status = await icall("GET", `/imports/${r2.body.data.modelId}?userId=imp7`)
  assert.equal(status.body.data.status, "FAILED")
  assert.equal(status.body.data.error, "チェックポイントではなく LoRA のファイルのようです")
  const row = await db.queryOne("SELECT status, disabled_reason, upload_id FROM user_models WHERE id = $1", [r2.body.data.modelId])
  assert.equal(row.status, "DELETED")
  assert.match(row.disabled_reason, /^import_failed: /)
  assert.equal((await callJson("GET", "/mine/imp7")).body.data.used, 0)
})

await t("取り込み: 壊れたファイル・Civitai の失敗が続く場合は FAILED（一般的なメッセージ）", async () => {
  const broken = new Uint8Array(4000)
  await addCivitaiModel({ id: 170, versionId: 271, file: broken })
  const r = await icall("POST", "/imports", { userId: "imp8", url: "https://civitai.com/models/170" })
  assert.equal((await runImport(startedImports.at(-1))).status, "FAILED")
  assert.equal((await icall("GET", `/imports/${r.body.data.modelId}?userId=imp8`)).body.data.error, "safetensors 形式のファイルではありません")

  await addCivitaiModel({ id: 180, versionId: 281, file: makeSafetensors(4100, undefined, 18) })
  const r2 = await icall("POST", "/imports", { userId: "imp9", url: "https://civitai.com/models/180" })
  civitai.rangeStatusOverride = 503
  assert.equal((await runImport(startedImports.at(-1))).status, "FAILED")
  civitai.rangeStatusOverride = null
  const s2 = await icall("GET", `/imports/${r2.body.data.modelId}?userId=imp9`)
  assert.equal(s2.body.data.status, "FAILED")
  assert.equal(s2.body.data.error, "Civitai からの取得に失敗しました（503）")
})

await t("取り込みの中止: 行は DELETED、Workflow はスキップ、multipart は破棄", async () => {
  const r = await icall("POST", "/imports", { userId: "imp10", url: "https://civitai.com/models/120" })
  const params = startedImports.at(-1)
  // 1 パート目まで進めてから中止
  const started = await imp.importStepStart(await importDeps(), params)
  assert.equal(started.skip, false)
  assert.equal((await icall("POST", `/imports/${r.body.data.modelId}/cancel`, { userId: "someone" })).status, 403)
  const c = await icall("POST", `/imports/${r.body.data.modelId}/cancel`, { userId: "imp10" })
  assert.equal(c.status, 200)
  assert.ok(bucket.aborted.includes(started.uploadId))
  const s = await icall("GET", `/imports/${r.body.data.modelId}?userId=imp10`)
  assert.equal(s.body.data.status, "FAILED")
  assert.equal(s.body.data.error, "取り込みを中止しました")
  assert.equal((await runImport(params)).status, "SKIPPED")
})

console.log(`\n${passed} passed`)
await pool.end()
await epg.stop()
process.exit(0)
