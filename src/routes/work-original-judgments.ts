// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// 作品がオリジナルか二次創作かの運営の判定（lib/work-original-judgments.ts）。moderatorUserId はフロントのサーバーがモデレーターだと確かめて渡す
import { Hono as Hono2 } from "hono"
import { array, boolean, nullable, object, optional, picklist, safeParse, string } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import {
  WORK_ORIGINAL_JUDGMENTS,
  getWorkOriginalJudgments,
  listWorkOriginalJudgmentLogs,
  setWorkOriginalJudgment,
} from "../lib/work-original-judgments"

export var workOriginalJudgmentListSchema = object({
  workIds: array(string()),
  withDetail: optional(boolean())
})
export var workOriginalJudgmentSetSchema = object({
  moderatorUserId: string(),
  workId: string(),
  judgment: nullable(picklist(WORK_ORIGINAL_JUDGMENTS)),
  note: optional(nullable(string()))
})

export var workOriginalJudgmentRoutes = new Hono2()
workOriginalJudgmentRoutes.use("*", requireInternalAuth)

// 作品ごとの判定（作品ページのバッジ・管理画面の一覧）。未判定の作品は含めない
workOriginalJudgmentRoutes.post("/list", async (c) => {
  const parsed = safeParse(workOriginalJudgmentListSchema, await c.req.json().catch(() => null))
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400)
  }
  const db = await getDb(c.env)
  return json({ error: null, data: await getWorkOriginalJudgments({ db, ...parsed.output }) })
})

// 判定を付ける・変える・外す（judgment: null で外す）
workOriginalJudgmentRoutes.post("/set", async (c) => {
  const parsed = safeParse(workOriginalJudgmentSetSchema, await c.req.json().catch(() => null))
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400)
  }
  const db = await getDb(c.env)
  const result = await setWorkOriginalJudgment({ db, core: c.env.SYSTEM_CORE ?? null, now: getNow(), ...parsed.output })
  if (result.error) {
    return json({ error: result.error }, result.status ?? 400)
  }
  return json({ error: null, data: result.data })
})

// 1 作品の判定の記録（新しい順）
workOriginalJudgmentRoutes.get("/:workId/logs", async (c) => {
  const db = await getDb(c.env)
  return json({ error: null, data: await listWorkOriginalJudgmentLogs({ db, workId: c.req.param("workId") }) })
})
