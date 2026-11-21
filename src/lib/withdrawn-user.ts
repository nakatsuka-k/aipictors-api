// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// 退会した人の個人情報をこの DB（DB）から消す。aipictors-system の退会処理が内部トークンで呼ぶ。
// - Discord 連携: 行ごと消す（Discord の ID・名前・アイコン・トークン、Aipictors の名前・ログイン ID）
// - お問い合わせ: 問い合わせとメッセージを消す（連絡先メールアドレス・名前・本文）
// - お知らせメールの送信記録: メールアドレスを空にする（同じお知らせを 2 回送らないための記録は残す）
// コイン・課金・報酬の記録はユーザー ID だけで、名前やメールアドレスは持たないので残す（法令の保存義務もある）

export const scrubWithdrawnUser = async ({ db, userId }) => {
  const id = String(userId)
  await db.batch([
    db.prepare("DELETE FROM discord_links WHERE user_id = ?").bind(id),
    db
      .prepare("DELETE FROM support_messages WHERE ticket_id IN (SELECT id FROM support_tickets WHERE user_id = ?)")
      .bind(id),
    db.prepare("DELETE FROM support_messages WHERE user_id = ?").bind(id),
    db.prepare("DELETE FROM support_tickets WHERE user_id = ?").bind(id),
    db.prepare("UPDATE email_campaign_sends SET email = '' WHERE user_id = ?").bind(id),
  ])
}
