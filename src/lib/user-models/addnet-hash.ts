// safetensors の本体（先頭 8 バイトのヘッダー長とヘッダーを除いた部分）の sha256。
// A1111/Forge が PNGInfo の「Lora hashes」に書く値（先頭 12 文字）・Civitai の AutoV3 と同じ。
// ピックアップモデルのお題で、アップロードした画像に書かれた LoRA を照合するのに使う（チェックポイントは sha256 の先頭 10 文字で足りる）
import type { Db, ModelBucket } from "./common"

type Bucket = Pick<ModelBucket, "get">

/** ストリームの sha256（16 進）。Workers は DigestStream、それ以外（テスト）は全部読んでから計算する */
export const sha256OfStream = async (stream: ReadableStream<Uint8Array>) => {
  const DigestStream = (crypto as unknown as { DigestStream?: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }).DigestStream
  let digest: ArrayBuffer
  if (DigestStream) {
    const sink = new DigestStream("SHA-256")
    await stream.pipeTo(sink)
    digest = await sink.digest
  } else {
    digest = await crypto.subtle.digest("SHA-256", await new Response(stream).arrayBuffer())
  }
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export const computeAddnetHash = async (bucket: Bucket, r2Key: string) => {
  const head = await bucket.get(r2Key, { range: { offset: 0, length: 8 } })
  if (!head) return null
  const bytes = new Uint8Array(await head.arrayBuffer())
  if (bytes.length < 8) return null
  const headerLength = Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true))
  if (!Number.isSafeInteger(headerLength) || headerLength <= 0) return null
  const body = await bucket.get(r2Key, { range: { offset: 8 + headerLength } })
  if (!body?.body) return null
  return sha256OfStream(body.body)
}

/** まだ無ければ計算して保存する（同じファイルを参照する行にまとめて書く）。計算できなければ null */
export const ensureAddnetHash = async (deps: { db: Db; bucket: Bucket }, modelId: string) => {
  const row = await deps.db.queryOne<{ r2_key: string; addnet_hash: string | null }>(
    "SELECT r2_key, addnet_hash FROM user_models WHERE id = $1",
    [modelId],
  )
  if (!row) return null
  if (row.addnet_hash) return row.addnet_hash
  const hash = await computeAddnetHash(deps.bucket, row.r2_key)
  if (!hash) return null
  await deps.db.execute("UPDATE user_models SET addnet_hash = $2 WHERE r2_key = $1 AND addnet_hash IS NULL", [row.r2_key, hash])
  return hash
}
