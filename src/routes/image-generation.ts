// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { array, boolean, nullable, number, object, optional, safeParse, string } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import { getDb } from "../lib/db"
import { cancelImageGenerationTask, countActiveReservedImageGenerationTasksForUser, countImageGenerationResults, countImageGenerationResultsForUserSince, countImageGenerationTasks, countImageGenerationTasksForUserByStatuses, countProtectedImageGenerationResultsForUser, createImageGenerationResult, createImageGenerationTask, createReservedImageGenerationTask, findCancelableImageGenerationTask, getFirstImageGenerationTask, getImageGenerationResultByNanoid, getImageGenerationResultByNanoidForUser, getImageGenerationTaskByNanoid, getImageGenerationTaskByNanoidForUser, getLatestReservedImageGenerationTaskForUser, getReservedImageGenerationTaskByNanoidForUser, listActiveReservedImageGenerationTasksForUser, listImageGenerationResults, listImageGenerationResultsForUser, listImageGenerationTasksForUser, markImageGenerationTaskErrored, markImageGenerationTaskGenerated, softDeleteAllReservedImageGenerationTasksForUser, softDeleteImageGenerationResult, softDeleteReservedImageGenerationTask, sumImageGenerationResultCosts, sumImageGenerationTaskCosts, sumImageGenerationTaskCostsForUserSince, updateImageGenerationResultProtected, updateImageGenerationResultRating, updateImageGenerationTaskById } from "../lib/image-generation"
import { json } from "../lib/json"
export var createTaskSchema = object({
  nanoid: string(),
  userId: number(),
  requestOriginContent: string(),
  requestContent: string(),
  type: string(),
  status: string(),
  priority: number(),
  requestTime: string(),
  platform: string(),
  sd: number(),
  cost: number(),
  uuid: string(),
  // 1 回の依頼で作る枚数（省略時は 1）
  count: optional(number())
});
export var updateTaskSchema = object({
  id: number(),
  status: string(),
  priority: number(),
  rating: number(),
  isDeleted: boolean()
});
export var deleteResultSchema = object({
  nanoid: string(),
  userId: number()
});
export var updateResultRatingSchema = object({
  nanoid: string(),
  userId: number(),
  rating: number()
});
export var updateResultProtectedSchema = object({
  nanoid: string(),
  userId: number(),
  isProtected: boolean()
});
export var cancelTaskSchema = object({
  id: number()
});
export var markTaskErroredSchema = object({
  nanoid: string(),
  generationTime: string(),
  error: optional(nullable(string()))
});
export var markTaskGeneratedSchema = object({
  nanoid: string(),
  imageUrl: string(),
  generationTime: string()
});
export var createResultSchema = object({
  userId: number(),
  requestContent: string(),
  requestTime: string(),
  imageUrl: string(),
  generationTime: string(),
  status: string(),
  cost: number(),
  thumbnailImageUrl: string(),
  requestToSdTime: string(),
  ipAddress: string(),
  requester: number(),
  priority: number(),
  type: string(),
  rating: number(),
  platform: string(),
  sd: number(),
  uuid: string(),
  nanoid: string(),
  modelName: string(),
  prompts: string()
});
export var createReservedTaskSchema = object({
  nanoid: string(),
  userId: number(),
  requestOriginContent: string(),
  requestContent: string(),
  ipAddress: string(),
  createdAt: string(),
  waitSeconds: number(),
  sd: number(),
  cost: number()
});
export var deleteReservedTaskSchema = object({
  nanoid: string(),
  userId: number()
});
export var deleteAllReservedTasksSchema = object({
  userId: number()
});
export var taskQuerySchema = object({
  userId: optional(nullable(number())),
  statuses: optional(nullable(array(string()))),
  priority: optional(nullable(number())),
  isDeleted: optional(nullable(boolean())),
  fromDate: optional(nullable(string())),
  requestTimeLte: optional(nullable(string()))
});
export var resultQuerySchema = object({
  userId: number(),
  statuses: optional(nullable(array(string()))),
  excludeStatuses: optional(nullable(array(string()))),
  isDeleted: optional(nullable(boolean())),
  imageUrlPresent: optional(nullable(boolean())),
  fromDate: optional(nullable(string()))
});
export var listResultQuerySchema = object({
  userId: number(),
  take: number(),
  skip: number(),
  statuses: optional(nullable(array(string()))),
  excludeStatuses: optional(nullable(array(string()))),
  isDeleted: optional(nullable(boolean())),
  imageUrlPresent: optional(nullable(boolean())),
  fromDate: optional(nullable(string()))
});
export var getNumberParam = (value) => {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
export var getBooleanParam = (value) => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
};
export var imageGenerationRoutes = new Hono2();
imageGenerationRoutes.use("*", requireInternalAuth);
imageGenerationRoutes.get("/tasks/by-nanoid/:nanoid", async (c) => {
  const db = await getDb(c.env);
  const nanoid = c.req.param("nanoid");
  const userId = getNumberParam(c.req.query("userId"));
  const data = userId === null ? await getImageGenerationTaskByNanoid(db, nanoid) : await getImageGenerationTaskByNanoidForUser(db, nanoid, userId);
  return json({ error: null, data });
});
imageGenerationRoutes.get("/reserved-tasks/by-nanoid/:nanoid", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.query("userId"));
  if (userId === null) {
    return json({ error: "userId is required" }, 400);
  }
  const data = await getReservedImageGenerationTaskByNanoidForUser(
    db,
    c.req.param("nanoid"),
    userId
  );
  return json({ error: null, data });
});
imageGenerationRoutes.get("/reserved-tasks/latest/:userId", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.param("userId"));
  if (userId === null) {
    return json({ error: "userId is required" }, 400);
  }
  const data = await getLatestReservedImageGenerationTaskForUser(db, userId);
  return json({ error: null, data });
});
imageGenerationRoutes.get("/reserved-tasks/:userId", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.param("userId"));
  if (userId === null) {
    return json({ error: "userId is required" }, 400);
  }
  const data = await listActiveReservedImageGenerationTasksForUser(db, userId);
  return json({ error: null, data });
});
imageGenerationRoutes.get("/reserved-tasks/count/:userId", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.param("userId"));
  if (userId === null) {
    return json({ error: "userId is required" }, 400);
  }
  const count = await countActiveReservedImageGenerationTasksForUser(db, userId);
  return json({ error: null, data: { count } });
});
imageGenerationRoutes.get("/results/by-nanoid/:nanoid", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.query("userId"));
  const data = userId === null ? await getImageGenerationResultByNanoid(db, c.req.param("nanoid")) : await getImageGenerationResultByNanoidForUser(
    db,
    c.req.param("nanoid"),
    userId
  );
  return json({ error: null, data });
});
imageGenerationRoutes.get("/results/count/:userId", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.param("userId"));
  const fromDate = c.req.query("fromDate");
  if (userId === null || !fromDate) {
    return json({ error: "userId and fromDate are required" }, 400);
  }
  const count = await countImageGenerationResultsForUserSince(
    db,
    userId,
    new Date(fromDate)
  );
  return json({ error: null, data: { count } });
});
imageGenerationRoutes.get("/tasks/count/:userId", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.param("userId"));
  const statuses = c.req.queries("status") ?? [];
  if (userId === null || statuses.length === 0) {
    return json({ error: "userId and status are required" }, 400);
  }
  const count = await countImageGenerationTasksForUserByStatuses(
    db,
    userId,
    statuses
  );
  return json({ error: null, data: { count } });
});
imageGenerationRoutes.get("/tasks/cost/:userId", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.param("userId"));
  const fromDate = c.req.query("fromDate");
  const statuses = c.req.queries("status") ?? [];
  if (userId === null || !fromDate || statuses.length === 0) {
    return json({ error: "userId, fromDate and status are required" }, 400);
  }
  const totalCost = await sumImageGenerationTaskCostsForUserSince(
    db,
    userId,
    new Date(fromDate),
    statuses
  );
  return json({ error: null, data: { totalCost } });
});
imageGenerationRoutes.get("/tasks", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.query("userId"));
  const take = getNumberParam(c.req.query("take"));
  const skip = getNumberParam(c.req.query("skip"));
  if (userId === null || take === null || skip === null) {
    return json({ error: "userId, take and skip are required" }, 400);
  }
  const data = await listImageGenerationTasksForUser(db, {
    userId,
    take,
    skip,
    where: {
      rating: getNumberParam(c.req.query("rating")),
      minRating: getNumberParam(c.req.query("minRating")),
      isProtected: getBooleanParam(c.req.query("isProtected")),
      dateText: c.req.query("dateText") ?? null,
      fromDate: c.req.query("fromDate") ?? null,
      uuids: c.req.queries("uuid")
    }
  });
  return json({ error: null, data });
});
imageGenerationRoutes.get("/results", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.query("userId"));
  const take = getNumberParam(c.req.query("take"));
  const skip = getNumberParam(c.req.query("skip"));
  if (userId === null || take === null || skip === null) {
    return json({ error: "userId, take and skip are required" }, 400);
  }
  const data = await listImageGenerationResultsForUser(db, {
    userId,
    take,
    skip,
    where: {
      rating: getNumberParam(c.req.query("rating")),
      minRating: getNumberParam(c.req.query("minRating")),
      isProtected: getBooleanParam(c.req.query("isProtected")),
      dateText: c.req.query("dateText") ?? null,
      fromDate: c.req.query("fromDate") ?? null,
      nanoids: c.req.queries("nanoid")
    }
  });
  return json({ error: null, data });
});
imageGenerationRoutes.get("/tasks/cancelable/:nanoid", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.query("userId"));
  if (userId === null) {
    return json({ error: "userId is required" }, 400);
  }
  const data = await findCancelableImageGenerationTask(
    db,
    userId,
    c.req.param("nanoid")
  );
  return json({ error: null, data });
});
imageGenerationRoutes.get("/results/protected-count/:userId", async (c) => {
  const db = await getDb(c.env);
  const userId = getNumberParam(c.req.param("userId"));
  if (userId === null) {
    return json({ error: "userId is required" }, 400);
  }
  const count = await countProtectedImageGenerationResultsForUser(db, userId);
  return json({ error: null, data: { count } });
});
imageGenerationRoutes.post("/tasks/create", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(createTaskSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await createImageGenerationTask(db, {
    ...parsed.output,
    requestTime: new Date(parsed.output.requestTime)
  });
  return json({ error: null, data });
});
imageGenerationRoutes.post("/tasks/query/count", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(taskQuerySchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const count = await countImageGenerationTasks(db, {
    userId: parsed.output.userId ?? null,
    statuses: parsed.output.statuses ?? null,
    priority: parsed.output.priority ?? null,
    isDeleted: parsed.output.isDeleted ?? null,
    fromDate: parsed.output.fromDate ? new Date(parsed.output.fromDate) : null,
    requestTimeLte: parsed.output.requestTimeLte ? new Date(parsed.output.requestTimeLte) : null
  });
  return json({ error: null, data: { count } });
});
imageGenerationRoutes.post("/tasks/query/first", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(taskQuerySchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await getFirstImageGenerationTask(db, {
    userId: parsed.output.userId ?? null,
    statuses: parsed.output.statuses ?? null,
    priority: parsed.output.priority ?? null,
    isDeleted: parsed.output.isDeleted ?? null,
    fromDate: parsed.output.fromDate ? new Date(parsed.output.fromDate) : null,
    requestTimeLte: parsed.output.requestTimeLte ? new Date(parsed.output.requestTimeLte) : null
  });
  return json({ error: null, data });
});
imageGenerationRoutes.post("/tasks/query/cost", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(taskQuerySchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const totalCost = await sumImageGenerationTaskCosts(db, {
    userId: parsed.output.userId ?? null,
    statuses: parsed.output.statuses ?? null,
    priority: parsed.output.priority ?? null,
    isDeleted: parsed.output.isDeleted ?? null,
    fromDate: parsed.output.fromDate ? new Date(parsed.output.fromDate) : null,
    requestTimeLte: parsed.output.requestTimeLte ? new Date(parsed.output.requestTimeLte) : null
  });
  return json({ error: null, data: { totalCost } });
});
imageGenerationRoutes.post("/results/query/list", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(listResultQuerySchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await listImageGenerationResults(db, {
    userId: parsed.output.userId,
    take: parsed.output.take,
    skip: parsed.output.skip,
    statuses: parsed.output.statuses ?? null,
    excludeStatuses: parsed.output.excludeStatuses ?? null,
    isDeleted: parsed.output.isDeleted ?? null,
    imageUrlPresent: parsed.output.imageUrlPresent ?? null,
    fromDate: parsed.output.fromDate ? new Date(parsed.output.fromDate) : null
  });
  return json({ error: null, data });
});
imageGenerationRoutes.post("/results/query/count", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(resultQuerySchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const count = await countImageGenerationResults(db, {
    userId: parsed.output.userId,
    statuses: parsed.output.statuses ?? null,
    excludeStatuses: parsed.output.excludeStatuses ?? null,
    isDeleted: parsed.output.isDeleted ?? null,
    imageUrlPresent: parsed.output.imageUrlPresent ?? null,
    fromDate: parsed.output.fromDate ? new Date(parsed.output.fromDate) : null
  });
  return json({ error: null, data: { count } });
});
imageGenerationRoutes.post("/results/query/cost", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(resultQuerySchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const totalCost = await sumImageGenerationResultCosts(db, {
    userId: parsed.output.userId,
    statuses: parsed.output.statuses ?? null,
    excludeStatuses: parsed.output.excludeStatuses ?? null,
    isDeleted: parsed.output.isDeleted ?? null,
    imageUrlPresent: parsed.output.imageUrlPresent ?? null,
    fromDate: parsed.output.fromDate ? new Date(parsed.output.fromDate) : null
  });
  return json({ error: null, data: { totalCost } });
});
imageGenerationRoutes.post("/reserved-tasks/create", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(createReservedTaskSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await createReservedImageGenerationTask(db, {
    ...parsed.output,
    createdAt: new Date(parsed.output.createdAt)
  });
  return json({ error: null, data });
});
imageGenerationRoutes.post("/tasks/update", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(updateTaskSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await updateImageGenerationTaskById(db, parsed.output.id, {
    status: parsed.output.status,
    priority: parsed.output.priority,
    rating: parsed.output.rating,
    isDeleted: parsed.output.isDeleted
  });
  return json({ error: null, data });
});
imageGenerationRoutes.post("/tasks/cancel", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(cancelTaskSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await cancelImageGenerationTask(db, parsed.output.id);
  return json({ error: null, data });
});
imageGenerationRoutes.post("/reserved-tasks/delete", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(deleteReservedTaskSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await softDeleteReservedImageGenerationTask(
    db,
    parsed.output.nanoid,
    parsed.output.userId
  );
  return json({ error: null, data });
});
imageGenerationRoutes.post("/reserved-tasks/delete-all", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(deleteAllReservedTasksSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await softDeleteAllReservedImageGenerationTasksForUser(
    db,
    parsed.output.userId
  );
  return json({ error: null, data });
});
imageGenerationRoutes.post("/tasks/mark-error", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(markTaskErroredSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await markImageGenerationTaskErrored(
    db,
    parsed.output.nanoid,
    new Date(parsed.output.generationTime),
    parsed.output.error ?? null
  );
  return json({ error: null, data });
});
imageGenerationRoutes.post("/tasks/mark-generated", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(markTaskGeneratedSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await markImageGenerationTaskGenerated(
    db,
    parsed.output.nanoid,
    parsed.output.imageUrl,
    new Date(parsed.output.generationTime)
  );
  return json({ error: null, data });
});
imageGenerationRoutes.post("/results/delete", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(deleteResultSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await softDeleteImageGenerationResult(
    db,
    parsed.output.nanoid,
    parsed.output.userId
  );
  return json({ error: null, data });
});
imageGenerationRoutes.post("/results/rating", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(updateResultRatingSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await updateImageGenerationResultRating(
    db,
    parsed.output.nanoid,
    parsed.output.userId,
    parsed.output.rating
  );
  return json({ error: null, data });
});
imageGenerationRoutes.post("/results/protected", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(updateResultProtectedSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await updateImageGenerationResultProtected(
    db,
    parsed.output.nanoid,
    parsed.output.userId,
    parsed.output.isProtected
  );
  return json({ error: null, data });
});
imageGenerationRoutes.post("/results/create", async (c) => {
  const body = await c.req.json();
  const parsed = safeParse(createResultSchema, body);
  if (!parsed.success) {
    return json({ error: "Invalid request body" }, 400);
  }
  const db = await getDb(c.env);
  const data = await createImageGenerationResult(db, {
    ...parsed.output,
    requestTime: new Date(parsed.output.requestTime),
    generationTime: new Date(parsed.output.generationTime),
    requestToSdTime: new Date(parsed.output.requestToSdTime)
  });
  return json({ error: null, data });
});
