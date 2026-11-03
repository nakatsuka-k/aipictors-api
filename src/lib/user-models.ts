// ユーザーがアップロードしたモデル（LoRA / チェックポイント）
//
// - ファイルは R2（USER_MODELS）に `models/<sha256>.safetensors` で保存する。同じ sha256 の READY なモデルがあれば
//   アップロードせずにそのファイルを参照する（重複排除）。R2 のファイルは参照する行が 0 になったら削除する。
// - アップロードは R2 multipart（50MB 固定のパート、最終パート以外は同サイズ）。最初のパートを流しながら
//   safetensors のヘッダー（先頭 8 バイトの長さ＋JSON）を検証し、ヘッダーから求めたファイルサイズが申告値と一致することも確認する。
// - sha256 はクライアントの申告値。サーバーでは計算しない（重い）。GPU 側がダウンロード後に検証し、
//   不一致なら /verify で同じファイルを参照する行をすべて DISABLED にする。
// - 登録上限はプラン（resolveCoinPlanType）ごと。pricing_settings の user_models.* で上書きできる。
export * from "./user-models/common"
export * from "./user-models/safetensors"
export * from "./user-models/serialize"
export * from "./user-models/input"
export * from "./user-models/queries"
export * from "./user-models/upload"
export * from "./user-models/manage"
export * from "./user-models/moderation"
