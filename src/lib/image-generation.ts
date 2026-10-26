// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
export var generatedQueueColumns = `
  id,
  user_id AS "userId",
  request_content,
  request_time,
  image_url,
  generation_time,
  progress,
  status,
  is_deleted,
  error,
  ip_address AS "IPAdress",
  request_to_sd_time,
  request_origin_content,
  thumbnail_image_url,
  requester,
  priority,
  type,
  rating,
  count,
  nanoid,
  platform,
  created_at,
  updated_at,
  is_canceled,
  is_reserved,
  sd,
  is_protected,
  cost,
  uuid
`;
export var imageGenerationResultColumns = `
  id,
  user_id AS "userId",
  request_content,
  request_time,
  image_url,
  generation_time,
  status,
  is_deleted,
  ip_address,
  request_to_sd_time,
  thumbnail_image_url,
  requester,
  priority,
  type,
  rating,
  nanoid,
  platform,
  created_at,
  updated_at,
  is_canceled,
  is_reserved,
  sd,
  is_protected,
  cost,
  uuid,
  model_name,
  prompts
`;
export var reservedImageGenerationTaskColumns = `
  id,
  user_id,
  request_content,
  request_origin_content,
  is_deleted,
  ip_address,
  created_at,
  wait_seconds,
  is_generated,
  sd,
  nanoid,
  cost
`;
export var getImageGenerationTaskByNanoid = async (db, nanoid) => {
  return db.queryOne(
    `SELECT ${generatedQueueColumns}
       FROM generated_queues
      WHERE nanoid = $1
      ORDER BY id DESC
      LIMIT 1`,
    [nanoid]
  );
};
export var getImageGenerationTaskByNanoidForUser = async (db, nanoid, userId) => {
  return db.queryOne(
    `SELECT ${generatedQueueColumns}
       FROM generated_queues
      WHERE nanoid = $1 AND is_deleted = FALSE AND user_id = $2
      ORDER BY id DESC
      LIMIT 1`,
    [nanoid, userId]
  );
};
export var getImageGenerationResultByNanoidForUser = async (db, nanoid, userId) => {
  return db.queryOne(
    `SELECT ${imageGenerationResultColumns}
       FROM image_generation_results
      WHERE nanoid = $1 AND is_deleted = FALSE AND user_id = $2
      ORDER BY id DESC
      LIMIT 1`,
    [nanoid, userId]
  );
};
export var getImageGenerationResultByNanoid = async (db, nanoid) => {
  return db.queryOne(
    `SELECT ${imageGenerationResultColumns}
       FROM image_generation_results
      WHERE nanoid = $1
      ORDER BY id DESC
      LIMIT 1`,
    [nanoid]
  );
};
export var getReservedImageGenerationTaskByNanoidForUser = async (db, nanoid, userId) => {
  return db.queryOne(
    `SELECT ${reservedImageGenerationTaskColumns}
       FROM generated_reservation_queues
      WHERE nanoid = $1 AND user_id = $2 AND is_deleted = FALSE
      ORDER BY id DESC
      LIMIT 1`,
    [nanoid, userId]
  );
};
export var getLatestReservedImageGenerationTaskForUser = async (db, userId) => {
  return db.queryOne(
    `SELECT ${reservedImageGenerationTaskColumns}
       FROM generated_reservation_queues
      WHERE user_id = $1 AND is_deleted = FALSE
      ORDER BY id DESC
      LIMIT 1`,
    [userId]
  );
};
export var listActiveReservedImageGenerationTasksForUser = async (db, userId) => {
  return db.query(
    `SELECT ${reservedImageGenerationTaskColumns}
       FROM generated_reservation_queues
      WHERE user_id = $1
        AND is_deleted = FALSE
        AND is_generated = FALSE
      ORDER BY id DESC`,
    [userId]
  );
};
export var countActiveReservedImageGenerationTasksForUser = async (db, userId) => {
  const result = await db.queryOne(
    `SELECT COUNT(*)::text AS count
       FROM generated_reservation_queues
      WHERE user_id = $1
        AND is_deleted = FALSE
        AND is_generated = FALSE`,
    [userId]
  );
  return Number(result?.count ?? 0);
};
export var createReservedImageGenerationTask = async (db, input) => {
  return db.queryOne(
    `INSERT INTO generated_reservation_queues (
       nanoid,
       user_id,
       request_origin_content,
       request_content,
       ip_address,
       created_at,
       wait_seconds,
       sd,
       cost,
       is_deleted,
       is_generated
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, FALSE
     )
     RETURNING ${reservedImageGenerationTaskColumns}`,
    [
      input.nanoid,
      input.userId,
      input.requestOriginContent,
      input.requestContent,
      input.ipAddress,
      input.createdAt,
      input.waitSeconds,
      input.sd,
      input.cost
    ]
  );
};
export var softDeleteReservedImageGenerationTask = async (db, nanoid, userId) => {
  const row = await db.queryOne(
    `DELETE FROM generated_reservation_queues
      WHERE nanoid = $1 AND user_id = $2 AND is_deleted = FALSE
    RETURNING ${reservedImageGenerationTaskColumns}`,
    [nanoid, userId]
  );
  if (row === null) {
    return null;
  }
  return {
    ...row,
    is_deleted: true
  };
};
export var softDeleteAllReservedImageGenerationTasksForUser = async (db, userId) => {
  const rows = await db.query(
    `DELETE FROM generated_reservation_queues
      WHERE user_id = $1 AND is_deleted = FALSE
    RETURNING ${reservedImageGenerationTaskColumns}`,
    [userId]
  );
  return rows.map((row) => ({
    ...row,
    is_deleted: true
  }));
};
export var listImageGenerationTasksForUser = async (db, args) => {
  const params = [args.userId];
  const conditions = [
    `user_id = $${params.length}`,
    `is_deleted = FALSE`,
    `status IN ('wait', 'generating')`
  ];
  if (args.where?.rating !== null && args.where?.rating !== void 0) {
    params.push(args.where.rating);
    conditions.push(`rating = $${params.length}`);
  }
  if (args.where?.minRating !== null && args.where?.minRating !== void 0) {
    params.push(args.where.minRating);
    conditions.push(`rating >= $${params.length}`);
  }
  if (args.where?.isProtected !== null && args.where?.isProtected !== void 0) {
    params.push(args.where.isProtected);
    conditions.push(`is_protected = $${params.length}`);
  }
  if (args.where?.dateText) {
    params.push(/* @__PURE__ */ new Date(`${args.where.dateText}T00:00:00+0000`));
    conditions.push(`request_time >= $${params.length}`);
    params.push(/* @__PURE__ */ new Date(`${args.where.dateText}T23:59:59+0000`));
    conditions.push(`request_time < $${params.length}`);
  }
  if (args.where?.fromDate) {
    params.push(new Date(args.where.fromDate));
    conditions.push(`updated_at >= $${params.length}`);
  }
  if (args.where?.uuids && args.where.uuids.length > 0) {
    params.push(args.where.uuids);
    conditions.push(`uuid = ANY($${params.length}::text[])`);
  }
  params.push(args.take);
  params.push(args.skip);
  return db.query(
    `SELECT ${generatedQueueColumns}
       FROM generated_queues
      WHERE ${conditions.join(" AND ")}
      ORDER BY request_time DESC, id DESC
      LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );
};
export var listImageGenerationResultsForUser = async (db, args) => {
  const params = [args.userId];
  const conditions = [
    `user_id = $${params.length}`,
    `is_deleted = FALSE`,
    `status NOT IN ('error', 'canceled')`
  ];
  if (args.where?.rating !== null && args.where?.rating !== void 0) {
    params.push(args.where.rating);
    conditions.push(`rating = $${params.length}`);
  }
  if (args.where?.minRating !== null && args.where?.minRating !== void 0) {
    params.push(args.where.minRating);
    conditions.push(`rating >= $${params.length}`);
  }
  if (args.where?.isProtected !== null && args.where?.isProtected !== void 0) {
    params.push(args.where.isProtected);
    conditions.push(`is_protected = $${params.length}`);
  }
  if (args.where?.dateText) {
    params.push(/* @__PURE__ */ new Date(`${args.where.dateText}T00:00:00+0000`));
    conditions.push(`request_time >= $${params.length}`);
    params.push(/* @__PURE__ */ new Date(`${args.where.dateText}T23:59:59+0000`));
    conditions.push(`request_time < $${params.length}`);
  }
  if (args.where?.fromDate) {
    params.push(new Date(args.where.fromDate));
    conditions.push(`updated_at >= $${params.length}`);
  }
  if (args.where?.nanoids && args.where.nanoids.length > 0) {
    params.push(args.where.nanoids);
    conditions.push(`nanoid = ANY($${params.length}::text[])`);
  }
  params.push(args.take);
  params.push(args.skip);
  return db.query(
    `SELECT ${imageGenerationResultColumns}
       FROM image_generation_results
      WHERE ${conditions.join(" AND ")}
      ORDER BY request_time DESC, generation_time DESC, id DESC
      LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );
};
export var createImageGenerationTask = async (db, input) => {
  return db.queryOne(
    `INSERT INTO generated_queues (
       nanoid,
       user_id,
       request_origin_content,
       request_content,
       type,
       status,
       priority,
       request_time,
       count,
       platform,
       sd,
       cost,
       uuid
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12
     )
     RETURNING ${generatedQueueColumns}`,
    [
      input.nanoid,
      input.userId,
      input.requestOriginContent,
      input.requestContent,
      input.type,
      input.status,
      input.priority,
      input.requestTime,
      input.platform,
      input.sd,
      input.cost,
      input.uuid
    ]
  );
};
export var markImageGenerationTaskErrored = async (db, nanoid, generationTime, error) => {
  return db.queryOne(
    `UPDATE generated_queues
        SET status = 'error',
            generation_time = $2,
            error = $3,
            updated_at = NOW()
      WHERE nanoid = $1
    RETURNING ${generatedQueueColumns}`,
    [nanoid, generationTime, error ?? null]
  );
};
export var markImageGenerationTaskGenerated = async (db, nanoid, imageUrl, generationTime) => {
  return db.queryOne(
    `UPDATE generated_queues
        SET image_url = $2,
            status = 'generated',
            generation_time = $3,
            updated_at = NOW()
      WHERE nanoid = $1
    RETURNING ${generatedQueueColumns}`,
    [nanoid, imageUrl, generationTime]
  );
};
export var updateImageGenerationTaskById = async (db, id, input) => {
  return db.queryOne(
    `UPDATE generated_queues
        SET status = $2,
            priority = $3,
            rating = $4,
            is_deleted = $5,
            updated_at = NOW()
      WHERE id = $1
    RETURNING ${generatedQueueColumns}`,
    [id, input.status, input.priority, input.rating, input.isDeleted]
  );
};
export var softDeleteImageGenerationResult = async (db, nanoid, userId) => {
  return db.queryOne(
    `UPDATE image_generation_results
        SET is_deleted = TRUE,
            updated_at = NOW()
      WHERE nanoid = $1 AND user_id = $2
    RETURNING ${imageGenerationResultColumns}`,
    [nanoid, userId]
  );
};
export var updateImageGenerationResultRating = async (db, nanoid, userId, rating) => {
  return db.queryOne(
    `UPDATE image_generation_results
        SET rating = $3,
            updated_at = NOW()
      WHERE nanoid = $1 AND user_id = $2 AND is_deleted = FALSE
    RETURNING ${imageGenerationResultColumns}`,
    [nanoid, userId, rating]
  );
};
export var countProtectedImageGenerationResultsForUser = async (db, userId) => {
  const result = await db.queryOne(
    `SELECT COUNT(*)::text AS count
       FROM image_generation_results
      WHERE user_id = $1 AND is_deleted = FALSE AND is_protected = TRUE`,
    [userId]
  );
  return Number(result?.count ?? 0);
};
export var updateImageGenerationResultProtected = async (db, nanoid, userId, isProtected) => {
  return db.queryOne(
    `UPDATE image_generation_results
        SET is_protected = $3,
            updated_at = NOW()
      WHERE nanoid = $1 AND user_id = $2 AND is_deleted = FALSE
    RETURNING ${imageGenerationResultColumns}`,
    [nanoid, userId, isProtected]
  );
};
export var findCancelableImageGenerationTask = async (db, userId, nanoid) => {
  return db.queryOne(
    `SELECT ${generatedQueueColumns}
       FROM generated_queues
      WHERE status IN ('wait', 'generating')
        AND is_deleted = FALSE
        AND user_id = $1
        AND nanoid = $2
      ORDER BY id DESC
      LIMIT 1`,
    [userId, nanoid]
  );
};
export var cancelImageGenerationTask = async (db, id) => {
  return db.queryOne(
    `UPDATE generated_queues
        SET is_canceled = 1,
            status = 'canceled',
            is_deleted = TRUE,
            updated_at = NOW()
      WHERE id = $1
    RETURNING ${generatedQueueColumns}`,
    [id]
  );
};
export var createImageGenerationResult = async (db, input) => {
  return db.queryOne(
    `INSERT INTO image_generation_results (
       user_id,
       request_content,
       request_time,
       image_url,
       generation_time,
       status,
       cost,
       thumbnail_image_url,
       request_to_sd_time,
       ip_address,
       requester,
       priority,
       type,
       rating,
       platform,
       sd,
       uuid,
       nanoid,
       model_name,
       prompts
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
     )
     RETURNING ${imageGenerationResultColumns}`,
    [
      input.userId,
      input.requestContent,
      input.requestTime,
      input.imageUrl,
      input.generationTime,
      input.status,
      input.cost,
      input.thumbnailImageUrl,
      input.requestToSdTime,
      input.ipAddress,
      input.requester,
      input.priority,
      input.type,
      input.rating,
      input.platform,
      input.sd,
      input.uuid,
      input.nanoid,
      input.modelName,
      input.prompts
    ]
  );
};
export var countImageGenerationResultsForUserSince = async (db, userId, since) => {
  const result = await db.queryOne(
    `SELECT COUNT(*)::text AS count
       FROM image_generation_results
      WHERE user_id = $1
        AND generation_time >= $2
        AND status <> 'error'
        AND is_deleted = FALSE`,
    [userId, since]
  );
  return Number(result?.count ?? 0);
};
export var countImageGenerationTasksForUserByStatuses = async (db, userId, statuses) => {
  const result = await db.queryOne(
    `SELECT COUNT(*)::text AS count
       FROM generated_queues
      WHERE user_id = $1
        AND status = ANY($2::generated_queue_status[])`,
    [userId, statuses]
  );
  return Number(result?.count ?? 0);
};
export var buildTaskQuery = (input) => {
  const params = [];
  const conditions = ["1 = 1"];
  if (input.userId !== null && input.userId !== void 0) {
    params.push(input.userId);
    conditions.push(`user_id = $${params.length}`);
  }
  if (input.statuses && input.statuses.length > 0) {
    params.push(input.statuses);
    conditions.push(`status = ANY($${params.length}::generated_queue_status[])`);
  }
  if (input.priority !== null && input.priority !== void 0) {
    params.push(input.priority);
    conditions.push(`priority = $${params.length}`);
  }
  if (input.isDeleted !== null && input.isDeleted !== void 0) {
    params.push(input.isDeleted);
    conditions.push(`is_deleted = $${params.length}`);
  }
  if (input.fromDate) {
    params.push(input.fromDate);
    conditions.push(`request_time >= $${params.length}`);
  }
  if (input.requestTimeLte) {
    params.push(input.requestTimeLte);
    conditions.push(`request_time <= $${params.length}`);
  }
  return { params, whereSql: conditions.join(" AND ") };
};
export var buildResultQuery = (input) => {
  const params = [input.userId];
  const conditions = [`user_id = $${params.length}`];
  if (input.statuses && input.statuses.length > 0) {
    params.push(input.statuses);
    conditions.push(`status = ANY($${params.length}::generated_queue_status[])`);
  }
  if (input.excludeStatuses && input.excludeStatuses.length > 0) {
    params.push(input.excludeStatuses);
    conditions.push(`NOT (status = ANY($${params.length}::generated_queue_status[]))`);
  }
  if (input.isDeleted !== null && input.isDeleted !== void 0) {
    params.push(input.isDeleted);
    conditions.push(`is_deleted = $${params.length}`);
  }
  if (input.imageUrlPresent) {
    conditions.push(`image_url IS NOT NULL`);
    conditions.push(`image_url <> ''`);
  }
  if (input.fromDate) {
    params.push(input.fromDate);
    conditions.push(`generation_time >= $${params.length}`);
  }
  return { params, whereSql: conditions.join(" AND ") };
};
export var countImageGenerationTasks = async (db, input) => {
  const { params, whereSql } = buildTaskQuery(input);
  const result = await db.queryOne(
    `SELECT COUNT(*)::text AS count
       FROM generated_queues
      WHERE ${whereSql}`,
    params
  );
  return Number(result?.count ?? 0);
};
export var getFirstImageGenerationTask = async (db, input) => {
  const { params, whereSql } = buildTaskQuery(input);
  return db.queryOne(
    `SELECT ${generatedQueueColumns}
       FROM generated_queues
      WHERE ${whereSql}
      ORDER BY request_time ASC, id ASC
      LIMIT 1`,
    params
  );
};
export var sumImageGenerationTaskCosts = async (db, input) => {
  const { params, whereSql } = buildTaskQuery(input);
  const result = await db.queryOne(
    `SELECT COALESCE(SUM(cost), 0)::text AS total_cost
       FROM generated_queues
      WHERE ${whereSql}`,
    params
  );
  return Number(result?.total_cost ?? 0);
};
export var sumImageGenerationTaskCostsForUserSince = async (db, userId, since, statuses) => {
  const result = await db.queryOne(
    `SELECT COALESCE(SUM(cost), 0)::text AS total_cost
       FROM generated_queues
      WHERE user_id = $1
        AND generation_time >= $2
        AND status = ANY($3::generated_queue_status[])`,
    [userId, since, statuses]
  );
  return Number(result?.total_cost ?? 0);
};
export var listImageGenerationResults = async (db, input) => {
  const { params, whereSql } = buildResultQuery(input);
  params.push(input.take);
  params.push(input.skip);
  return db.query(
    `SELECT ${imageGenerationResultColumns}
       FROM image_generation_results
      WHERE ${whereSql}
      ORDER BY request_time DESC, generation_time DESC, id DESC
      LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );
};
export var countImageGenerationResults = async (db, input) => {
  const { params, whereSql } = buildResultQuery(input);
  const result = await db.queryOne(
    `SELECT COUNT(*)::text AS count
       FROM image_generation_results
      WHERE ${whereSql}`,
    params
  );
  return Number(result?.count ?? 0);
};
export var sumImageGenerationResultCosts = async (db, input) => {
  const { params, whereSql } = buildResultQuery(input);
  const result = await db.queryOne(
    `SELECT COALESCE(SUM(cost), 0)::text AS total_cost
       FROM image_generation_results
      WHERE ${whereSql}`,
    params
  );
  return Number(result?.total_cost ?? 0);
};
