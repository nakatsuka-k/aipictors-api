// 週替わりのピックアップモデルの内部 API（INTERNAL_API_TOKEN 認証）。
// 公開の取得はフロントの /api/user-models/pickup、運営の操作は /api/admin/user-models/pickups（モデレーターの確認はフロント側）
import { Hono, type Context } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getGenlogDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import {
  PickupError,
  decidePickup,
  getCurrentPickup,
  jstWeekStart,
  listPickupCandidates,
  listPickups,
  type PickupDeps,
} from "../lib/user-model-pickups"

type AppContext = Context<{ Bindings: Env }>

export type GetPickupDeps = (c: AppContext) => Promise<PickupDeps>

export const pickupDepsFromEnv = async (env: Env): Promise<PickupDeps> => {
  const e = env as Env & { SYSTEM_CORE?: D1Database; SYSTEM_ACTIVITY?: D1Database }
  return {
    db: await getDb(env),
    genlog: await getGenlogDb(env),
    system: { core: e.SYSTEM_CORE ?? null, activity: e.SYSTEM_ACTIVITY ?? null },
    now: getNow(),
  }
}

const readJson = async (c: AppContext): Promise<Record<string, unknown>> => {
  try {
    const body = await c.req.json()
    return body && typeof body === "object" && !Array.isArray(body) ? body : {}
  } catch {
    return {}
  }
}

const handle = (fn: (c: AppContext) => Promise<unknown>) => async (c: AppContext) => {
  try {
    return json({ error: null, data: await fn(c) })
  } catch (e) {
    if (e instanceof PickupError) return json({ error: e.message, data: null }, e.status)
    throw e
  }
}

export const createUserModelPickupRoutes = (getDeps: GetPickupDeps = (c) => pickupDepsFromEnv(c.env)) => {
  const routes = new Hono<{ Bindings: Env }>()
  routes.use("*", requireInternalAuth)

  // 今週のピックアップ（無ければ null）
  routes.get(
    "/",
    handle(async (c) => {
      const deps = await getDeps(c)
      return getCurrentPickup(deps.db, deps.now)
    }),
  )

  // 管理: 直近の週と、今週（または ?weekStart=）の候補
  routes.get(
    "/admin",
    handle(async (c) => {
      const deps = await getDeps(c)
      const weekStart = c.req.query("weekStart") || jstWeekStart(deps.now)
      const [pickups, candidates] = await Promise.all([listPickups(deps.db, 12), listPickupCandidates(deps, weekStart)])
      return { weekStart, currentWeekStart: jstWeekStart(deps.now), pickups, candidates: candidates.slice(0, 30) }
    }),
  )

  // 管理: その週のモデルを差し替える（{ modelId, decidedBy }）
  routes.put(
    "/admin/:weekStart",
    handle(async (c) => {
      const deps = await getDeps(c)
      const body = await readJson(c)
      if (typeof body.modelId !== "string" || body.modelId === "") throw new PickupError(400, "modelId を指定してください")
      return decidePickup(deps, {
        weekStart: c.req.param("weekStart") ?? "",
        modelId: body.modelId,
        source: "ADMIN",
        decidedBy: typeof body.decidedBy === "string" ? body.decidedBy : null,
      })
    }),
  )

  // 管理: 自動の選び方で選び直す（運営の差し替えも上書きする）
  routes.post(
    "/admin/:weekStart/auto",
    handle(async (c) => {
      const deps = await getDeps(c)
      const weekStart = c.req.param("weekStart") ?? ""
      const candidates = await listPickupCandidates(deps, weekStart)
      const best = candidates.find((x) => x.excludedReason === null)
      if (!best) throw new PickupError(404, "選べる候補がありません")
      return decidePickup(deps, { weekStart, modelId: best.modelId, source: "AUTO", candidate: best })
    }),
  )

  return routes
}

export const userModelPickupRoutes = createUserModelPickupRoutes()
