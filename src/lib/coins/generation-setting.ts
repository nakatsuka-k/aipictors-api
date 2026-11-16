// @ts-nocheck
// 「画像生成にプレミアムコインを使わない」設定（core の user_settings.disable_premium_coin_generation、Web・アプリの設定で変える）

/** 画像生成の消費（通常・予約・Flux・Gemini。呼び出し元は reason を image-generation: で始める） */
export const isImageGenerationCoinReason = (reason) => {
  return typeof reason === "string" && reason.startsWith("image-generation:")
}

/**
 * 生成にプレミアムコインを使わない設定かどうか。
 * core が読めない・列がまだ無いときは使う扱い（今まで通りフリーコインから先に、足りない分はプレミアム）
 */
export const isPremiumCoinGenerationDisabled = async (core, userId) => {
  if (!core || !/^\d+$/.test(String(userId ?? ""))) return false
  try {
    const row = await core
      .prepare(`SELECT disable_premium_coin_generation AS disabled FROM user_settings WHERE userId = ?`)
      .bind(Number(userId))
      .first()
    return Number(row?.disabled ?? 0) === 1
  } catch (error) {
    console.log(JSON.stringify({ event: "coins.generation_setting_failed", message: String(error?.message ?? error) }))
    return false
  }
}
