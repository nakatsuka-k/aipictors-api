// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// 感謝コインの順位と集計（読むだけ）
import {
  ANONYMOUS_SUPPORT_USER_ID,
  CONTRIBUTION_RANKING_EXCLUDED_USER_ID,
  getSupportWeekStartDate,
} from "./common"
export var getSupportWeeklyRanking = async (props) => {
  const weekStartDate = props.weekStartDate ?? getSupportWeekStartDate();
  const offset = Math.max(0, Math.floor(props.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(props.limit ?? 100)));
  const userColumn = props.kind === "received" ? "recipient_user_id" : "sender_user_id";
  const excludeContributionUserId = props.kind === "sent" ? CONTRIBUTION_RANKING_EXCLUDED_USER_ID : null;
  if (props.kind === "sent" && props.recipientUserId) {
    // Neon は 1 文ごとに HTTP の往復になるので同時に投げる
    const [items2, countRow2] = await Promise.all([
    props.db.query(
      `WITH grouped AS (
         SELECT CASE
                  WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
                  ELSE sender_user_id
                END AS "userId",
                SUM(coin_amount) AS "coinAmount",
                SUM(pt_amount) AS "ptAmount",
                SUM(CASE WHEN coin_type = 'FREE' THEN pt_amount ELSE 0 END) AS "freePtAmount",
                SUM(CASE WHEN coin_type = 'PREMIUM' THEN pt_amount ELSE 0 END) AS "premiumPtAmount",
                COUNT(*) AS "transferCount",
                BOOL_OR(is_anonymous) AS "isAnonymous"
           FROM coin_support_transfers
          WHERE recipient_user_id = $1
            AND sender_user_id <> $4
          GROUP BY CASE
                     WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
                     ELSE sender_user_id
                   END
       ),
       ranked AS (
         SELECT "userId",
                "coinAmount",
                "ptAmount",
                "freePtAmount",
                "premiumPtAmount",
                "transferCount",
                "isAnonymous",
                ROW_NUMBER() OVER (
                  ORDER BY "ptAmount" DESC, "transferCount" DESC, "userId" ASC
                ) AS rank
           FROM grouped
       )
       SELECT rank,
              "userId",
              "coinAmount",
              "ptAmount",
              "freePtAmount",
              "premiumPtAmount",
                  "transferCount",
                  "isAnonymous"
         FROM ranked
        ORDER BY rank ASC
        LIMIT $2
       OFFSET $3`,
      [props.recipientUserId, limit, offset, CONTRIBUTION_RANKING_EXCLUDED_USER_ID]
    ),
    props.db.queryOne(
      `SELECT COUNT(*) AS count
         FROM (
           SELECT CASE
                    WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
                    ELSE sender_user_id
                  END AS sender_label
             FROM coin_support_transfers
            WHERE recipient_user_id = $1
              AND sender_user_id <> $2
            GROUP BY CASE
                       WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
                       ELSE sender_user_id
                     END
         ) AS grouped`,
      [props.recipientUserId, CONTRIBUTION_RANKING_EXCLUDED_USER_ID]
    )
    ]);
    return {
      kind: props.kind,
      weekStartDate: "",
      items: items2,
      totalCount: countRow2?.count ?? 0,
      offset,
      limit
    };
  }
  // Neon は 1 文ごとに HTTP の往復になるので同時に投げる
  const [items, countRow] = await Promise.all([
  props.db.query(
    `WITH grouped AS (
       SELECT ${userColumn} AS "userId",
              SUM(coin_amount) AS "coinAmount",
              SUM(pt_amount) AS "ptAmount",
              SUM(CASE WHEN coin_type = 'FREE' THEN pt_amount ELSE 0 END) AS "freePtAmount",
              SUM(CASE WHEN coin_type = 'PREMIUM' THEN pt_amount ELSE 0 END) AS "premiumPtAmount",
              COUNT(*) AS "transferCount"
         FROM coin_support_transfers
        WHERE week_start_date = $1
         AND ($4 IS NULL OR ${userColumn} <> $4)
        GROUP BY ${userColumn}
     ),
     ranked AS (
       SELECT "userId",
              "coinAmount",
              "ptAmount",
              "freePtAmount",
              "premiumPtAmount",
              "transferCount",
              ROW_NUMBER() OVER (
                ORDER BY "ptAmount" DESC, "transferCount" DESC, "userId" ASC
              ) AS rank
         FROM grouped
     )
     SELECT rank,
            "userId",
            "coinAmount",
            "ptAmount",
            "freePtAmount",
            "premiumPtAmount",
            "transferCount"
       FROM ranked
      ORDER BY rank ASC
      LIMIT $2
     OFFSET $3`,
    [weekStartDate, limit, offset, excludeContributionUserId]
  ),
  props.db.queryOne(
    `SELECT COUNT(*) AS count
       FROM (
         SELECT ${userColumn}
           FROM coin_support_transfers
          WHERE week_start_date = $1
            AND ($2 IS NULL OR ${userColumn} <> $2)
          GROUP BY ${userColumn}
       ) AS grouped`,
    [weekStartDate, excludeContributionUserId]
  )
  ]);
  return {
    kind: props.kind,
    weekStartDate,
    items,
    totalCount: countRow?.count ?? 0,
    offset,
    limit
  };
};

export var getSupportPeriodRanking = async (props) => {
  const offset = Math.max(0, Math.floor(props.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(props.limit ?? 100)));
  const userColumn = props.kind === "received" ? "recipient_user_id" : "sender_user_id";
  const excludeContributionUserId = props.kind === "sent" ? CONTRIBUTION_RANKING_EXCLUDED_USER_ID : null;
  const getPeriodFilter = () => {
    if (props.period === "weekly") {
      return {
        whereSql: "week_start_date = $1",
        params: [props.periodKey]
      };
    }
    if (props.period === "monthly") {
      return {
        whereSql: "to_char(timezone('Asia/Tokyo', to_timestamp(created_at)), 'YYYY-MM') = $1",
        params: [props.periodKey]
      };
    }
    return {
      whereSql: "to_char(timezone('Asia/Tokyo', to_timestamp(created_at)), 'YYYY-MM-DD') = $1",
      params: [props.periodKey]
    };
  };
  const { whereSql, params } = getPeriodFilter();
  // Neon は 1 文ごとに HTTP の往復になるので同時に投げる
  const [items, countRow] = await Promise.all([
  props.db.query(
    `WITH grouped AS (
       SELECT ${userColumn} AS "userId",
              SUM(coin_amount) AS "coinAmount",
              SUM(pt_amount) AS "ptAmount",
              SUM(CASE WHEN coin_type = 'FREE' THEN pt_amount ELSE 0 END) AS "freePtAmount",
              SUM(CASE WHEN coin_type = 'PREMIUM' THEN pt_amount ELSE 0 END) AS "premiumPtAmount",
              COUNT(*) AS "transferCount"
         FROM coin_support_transfers
        WHERE ${whereSql}
         AND ($2 IS NULL OR ${userColumn} <> $2)
        GROUP BY ${userColumn}
     ),
     ranked AS (
       SELECT "userId",
              "coinAmount",
              "ptAmount",
              "freePtAmount",
              "premiumPtAmount",
              "transferCount",
              ROW_NUMBER() OVER (
                ORDER BY "ptAmount" DESC, "transferCount" DESC, "userId" ASC
              ) AS rank
         FROM grouped
     )
     SELECT rank,
            "userId",
            "coinAmount",
            "ptAmount",
            "freePtAmount",
            "premiumPtAmount",
            "transferCount"
       FROM ranked
      ORDER BY rank ASC
      LIMIT $3
     OFFSET $4`,
    [...params, excludeContributionUserId, limit, offset]
  ),
  props.db.queryOne(
    `SELECT COUNT(*) AS count
       FROM (
         SELECT ${userColumn}
           FROM coin_support_transfers
          WHERE ${whereSql}
            AND ($2 IS NULL OR ${userColumn} <> $2)
          GROUP BY ${userColumn}
       ) AS grouped`,
    [...params, excludeContributionUserId]
  )
  ]);
  return {
    kind: props.kind,
    period: props.period,
    periodKey: props.periodKey,
    items,
    totalCount: countRow?.count ?? 0,
    offset,
    limit
  };
};

export var getSupportAvailableWeekStartDates = async (db, limit = 8) => {
  const recentWeeks = await db.query(
    `SELECT week_start_date AS "weekStartDate"
       FROM (
         SELECT DISTINCT week_start_date
           FROM coin_support_weekly_received_points
         UNION
         SELECT DISTINCT week_start_date
           FROM coin_support_weekly_sent_points
       ) AS weeks
      ORDER BY week_start_date DESC
      LIMIT $1`,
    [Math.min(50, Math.max(1, Math.floor(limit)))]
  );
  const currentWeekStartDate = getSupportWeekStartDate();
  const weekStartDates = [
    currentWeekStartDate,
    ...recentWeeks.map((row) => row.weekStartDate)
  ];
  return Array.from(new Set(weekStartDates)).slice(0, limit);
};

export var getSupportSummary = async (props) => {
  const weekStartDate = props.weekStartDate ?? getSupportWeekStartDate();
  // Neon は 1 文ごとに HTTP の往復になるので、読むだけの文は同時に投げる
  const [
    totals,
    weeklySent,
    weeklyReceived,
    sentRank,
    receivedRank,
    availableWeekStartDates,
    receivedBreakdownRows,
    recentReceivedTransfers,
  ] = await Promise.all([
    props.db.queryOne(
    `SELECT sent_pt_total,
            received_pt_total,
            sent_coin_total,
            received_coin_total
       FROM coin_support_totals
      WHERE user_id = $1`,
    [props.userId]
    ),
    props.db.queryOne(
    `SELECT pt_amount, coin_amount, transfer_count
       FROM coin_support_weekly_sent_points
      WHERE week_start_date = $1
        AND user_id = $2`,
    [weekStartDate, props.userId]
    ),
    props.db.queryOne(
    `SELECT pt_amount, coin_amount, transfer_count
       FROM coin_support_weekly_received_points
      WHERE week_start_date = $1
        AND user_id = $2`,
    [weekStartDate, props.userId]
    ),
    props.db.queryOne(
    `WITH ranked AS (
       SELECT user_id,
              ROW_NUMBER() OVER (
                ORDER BY pt_amount DESC, transfer_count DESC, user_id ASC
              ) AS rank
         FROM coin_support_weekly_sent_points
        WHERE week_start_date = $1
          AND user_id <> $3
     )
     SELECT rank
       FROM ranked
      WHERE user_id = $2`,
    [weekStartDate, props.userId, CONTRIBUTION_RANKING_EXCLUDED_USER_ID]
    ),
    props.db.queryOne(
    `WITH ranked AS (
       SELECT user_id,
              ROW_NUMBER() OVER (
                ORDER BY pt_amount DESC, transfer_count DESC, user_id ASC
              ) AS rank
         FROM coin_support_weekly_received_points
        WHERE week_start_date = $1
     )
     SELECT rank
       FROM ranked
      WHERE user_id = $2`,
    [weekStartDate, props.userId]
    ),
    getSupportAvailableWeekStartDates(props.db),
    props.db.query(
    `SELECT coin_type,
            COALESCE(SUM(coin_amount), 0) AS coin_amount,
            COALESCE(SUM(pt_amount), 0) AS pt_amount
       FROM coin_support_transfers
      WHERE recipient_user_id = $1
      GROUP BY coin_type`,
    [props.userId]
    ),
    props.db.query(
    `SELECT CASE
              WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
              ELSE sender_user_id
            END AS "senderUserId",
            is_anonymous AS "isAnonymous",
            coin_type AS "coinType",
            coin_amount AS "coinAmount",
            pt_amount AS "ptAmount",
            created_at AS "createdAt"
       FROM coin_support_transfers
      WHERE recipient_user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 20`,
    [props.userId]
    )
  ]);
  // 累計の順位（自分より多い人の数 + 1）。まだ貢献・受取がなければ順位なし
  const sentPtTotal = Number(totals?.sent_pt_total ?? 0);
  const receivedPtTotal = Number(totals?.received_pt_total ?? 0);
  const [cumulativeSentRank, cumulativeReceivedRank] = await Promise.all([
    sentPtTotal > 0 && props.userId !== CONTRIBUTION_RANKING_EXCLUDED_USER_ID
      ? props.db.queryOne(
          `SELECT COUNT(*) + 1 AS rank
             FROM coin_support_totals
            WHERE sent_pt_total > $1
              AND user_id <> $2`,
          [sentPtTotal, CONTRIBUTION_RANKING_EXCLUDED_USER_ID]
        )
      : null,
    receivedPtTotal > 0
      ? props.db.queryOne(
          `SELECT COUNT(*) + 1 AS rank
             FROM coin_support_totals
            WHERE received_pt_total > $1`,
          [receivedPtTotal]
        )
      : null
  ]);
  const receivedFree = receivedBreakdownRows.find(
    (row) => row.coin_type === "FREE"
  );
  const receivedPremium = receivedBreakdownRows.find(
    (row) => row.coin_type === "PREMIUM"
  );
  return {
    userId: props.userId,
    weekStartDate,
    cumulativeSentPt: totals?.sent_pt_total ?? 0,
    cumulativeReceivedPt: totals?.received_pt_total ?? 0,
    cumulativeSentCoins: totals?.sent_coin_total ?? 0,
    cumulativeReceivedCoins: totals?.received_coin_total ?? 0,
    cumulativeReceivedFreeCoins: receivedFree?.coin_amount ?? 0,
    cumulativeReceivedPremiumCoins: receivedPremium?.coin_amount ?? 0,
    cumulativeReceivedFreePt: receivedFree?.pt_amount ?? 0,
    cumulativeReceivedPremiumPt: receivedPremium?.pt_amount ?? 0,
    weeklySentPt: weeklySent?.pt_amount ?? 0,
    weeklyReceivedPt: weeklyReceived?.pt_amount ?? 0,
    weeklySentCoinAmount: weeklySent?.coin_amount ?? 0,
    weeklyReceivedCoinAmount: weeklyReceived?.coin_amount ?? 0,
    weeklySentTransferCount: weeklySent?.transfer_count ?? 0,
    weeklyReceivedTransferCount: weeklyReceived?.transfer_count ?? 0,
    weeklySentRank: sentRank?.rank ?? null,
    weeklyReceivedRank: receivedRank?.rank ?? null,
    cumulativeSentRank: cumulativeSentRank?.rank ?? null,
    cumulativeReceivedRank: cumulativeReceivedRank?.rank ?? null,
    availableWeekStartDates,
    recentReceivedTransfers
  };
};

// 累計の貢献・受取だけ（実績の判定で 5 分おきに読むので軽くする）
export var getSupportTotals = async (props) => {
  const totals = await props.db.queryOne(
    `SELECT sent_pt_total, received_pt_total
       FROM coin_support_totals
      WHERE user_id = $1`,
    [props.userId]
  );
  return {
    cumulativeSentPt: Number(totals?.sent_pt_total ?? 0),
    cumulativeReceivedPt: Number(totals?.received_pt_total ?? 0),
  };
};
