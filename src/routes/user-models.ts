// ユーザーモデル（LoRA / チェックポイント）の内部 API。すべて INTERNAL_API_TOKEN 認証。
// ユーザー認証は呼び出し側（フロントの Remix api ルート）が行い、userId を渡す。
import { Hono, type Context } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import {
  UserModelError,
  abortUserModelUpload,
  completeUserModelUpload,
  createUserModelUpload,
  deleteUserModel,
  getUserModel,
  getUserModelFileResponse,
  listMyUserModels,
  listUserModels,
  markUserModelUsed,
  updateUserModel,
  uploadUserModelPart,
  verifyUserModelFile,
  type UserModelDeps,
} from "../lib/user-models"

type Bindings = Env & { USER_MODELS: R2Bucket }
type AppContext = Context<{ Bindings: Bindings }>

export type GetUserModelDeps = (c: AppContext) => Promise<UserModelDeps>

const defaultDeps: GetUserModelDeps = async (c) => {
  if (!c.env.USER_MODELS) throw new Error("USER_MODELS bucket is not configured")
  return { db: await getDb(c.env), bucket: c.env.USER_MODELS, now: getNow() }
}

const param = (c: AppContext, name: string) => c.req.param(name) ?? ""

const readJson = async (c: AppContext): Promise<Record<string, unknown>> => {
  try {
    const body = await c.req.json()
    return body && typeof body === "object" && !Array.isArray(body) ? body : {}
  } catch {
    return {}
  }
}

const handle = (fn: (c: AppContext) => Promise<Response | unknown>) => async (c: AppContext) => {
  try {
    const result = await fn(c)
    return result instanceof Response ? result : json({ error: null, data: result })
  } catch (e) {
    if (e instanceof UserModelError) {
      return json({ error: e.message, code: e.code }, e.status)
    }
    throw e
  }
}

export const createUserModelsRoutes = (getDeps: GetUserModelDeps = defaultDeps) => {
  const routes = new Hono<{ Bindings: Bindings }>()
  routes.use("*", requireInternalAuth)

  routes.post(
    "/uploads",
    handle(async (c) => createUserModelUpload(await getDeps(c), await readJson(c))),
  )

  routes.put(
    "/uploads/:modelId/parts/:partNumber",
    handle(async (c) => {
      const length = c.req.header("content-length")
      return uploadUserModelPart(await getDeps(c), {
        modelId: param(c, "modelId"),
        partNumber: Number(param(c, "partNumber")),
        userId: c.req.query("userId") ?? null,
        contentLength: length === undefined || length === "" ? null : Number(length),
        body: c.req.raw.body,
      })
    }),
  )

  routes.post(
    "/uploads/:modelId/complete",
    handle(async (c) => {
      const body = await readJson(c)
      return completeUserModelUpload(await getDeps(c), {
        modelId: param(c, "modelId"),
        userId: typeof body.userId === "string" ? body.userId : null,
        parts: body.parts,
      })
    }),
  )

  routes.post(
    "/uploads/:modelId/abort",
    handle(async (c) => {
      const body = await readJson(c)
      return abortUserModelUpload(await getDeps(c), {
        modelId: param(c, "modelId"),
        userId: typeof body.userId === "string" ? body.userId : null,
      })
    }),
  )

  routes.get(
    "/",
    handle(async (c) => {
      const { db } = await getDeps(c)
      return listUserModels(db, {
        kind: c.req.query("kind"),
        q: c.req.query("q"),
        baseModel: c.req.query("baseModel"),
        sort: c.req.query("sort"),
        ratings: c.req.query("ratings"),
        userId: c.req.query("userId"),
        tag: c.req.query("tag"),
        offset: c.req.query("offset"),
        limit: c.req.query("limit"),
      })
    }),
  )

  routes.get(
    "/mine/:userId",
    handle(async (c) => {
      const { db, now } = await getDeps(c)
      return listMyUserModels(db, param(c, "userId"), c.req.query("planType"), now)
    }),
  )

  routes.get(
    "/:id/file",
    handle(async (c) => getUserModelFileResponse(await getDeps(c), param(c, "id"), c.req.header("range") ?? null)),
  )

  routes.post(
    "/:id/used",
    handle(async (c) => {
      const { db, now } = await getDeps(c)
      const body = await readJson(c)
      return markUserModelUsed(db, param(c, "id"), body.count, now)
    }),
  )

  routes.post(
    "/:id/verify",
    handle(async (c) => {
      const { db, now } = await getDeps(c)
      const body = await readJson(c)
      return verifyUserModelFile(db, param(c, "id"), body.sha256, now)
    }),
  )

  routes.get(
    "/:id",
    handle(async (c) => {
      const { db } = await getDeps(c)
      return getUserModel(db, param(c, "id"))
    }),
  )

  routes.patch(
    "/:id",
    handle(async (c) => {
      const { db, now } = await getDeps(c)
      return updateUserModel(db, param(c, "id"), await readJson(c), now)
    }),
  )

  routes.delete(
    "/:id",
    handle(async (c) => {
      const body = await readJson(c)
      return deleteUserModel(await getDeps(c), param(c, "id"), body.userId ?? c.req.query("userId"))
    }),
  )

  return routes
}

export const userModelsRoutes = createUserModelsRoutes()
