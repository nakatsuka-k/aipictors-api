// safetensors のヘッダーの検査
import { USER_MODEL_PART_SIZE, UserModelError } from "./common"
import type { UserModelKind } from "./common"
// safetensors のヘッダーは最初のパートに収まっていること（仕様上の上限は 100MB だが実物は数 MB 以下）
const MAX_SAFETENSORS_HEADER_BYTES = 32 * 1024 * 1024

// ---- safetensors の検証 ----

export class SafetensorsError extends UserModelError {
  constructor(message: string) {
    super(400, "INVALID_SAFETENSORS", message)
  }
}

const isLoraKey = (key: string) => /lora|hada_|lokr_|\.oft_|^oft_/i.test(key)

const isFullModelKey = (key: string) =>
  key.startsWith("model.diffusion_model.") || key.startsWith("first_stage_model.") || key.startsWith("conditioner.")

// 先頭 8 バイト（ヘッダー長, u64 LE）＋ヘッダー JSON を検証する。ヘッダーの data_offsets から求めたサイズが totalSize と一致すること。
// strictKind=false のときは種類違いを KIND_MISMATCH にせず warnings に入れるだけ（Civitai から取り込む SDXL 以外の系統など、
// キーの名前から種類を判定できないことがあるため）
export type SafetensorsCheckOptions = { strictKind?: boolean; onWarning?: (message: string) => void }

export const validateSafetensorsHeader = (
  header: Uint8Array,
  totalSize: number,
  kind: UserModelKind,
  options: SafetensorsCheckOptions = {},
) => {
  const strictKind = options.strictKind ?? true
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header))
  } catch {
    throw new SafetensorsError("safetensors のヘッダーを読めません")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SafetensorsError("safetensors のヘッダーが不正です")
  }
  let dataEnd = 0
  const keys: string[] = []
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === "__metadata__") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SafetensorsError("safetensors の __metadata__ が不正です")
      }
      continue
    }
    const tensor = value as { dtype?: unknown; shape?: unknown; data_offsets?: unknown }
    const offsets = tensor?.data_offsets
    if (
      typeof tensor?.dtype !== "string" ||
      !Array.isArray(tensor.shape) ||
      !Array.isArray(offsets) ||
      offsets.length !== 2 ||
      !offsets.every((n) => Number.isSafeInteger(n) && n >= 0) ||
      offsets[0] > offsets[1]
    ) {
      throw new SafetensorsError(`safetensors のテンソル情報が不正です: ${key.slice(0, 100)}`)
    }
    dataEnd = Math.max(dataEnd, offsets[1])
    keys.push(key)
  }
  if (keys.length === 0) {
    throw new SafetensorsError("safetensors にテンソルがありません")
  }
  if (8 + header.length + dataEnd !== totalSize) {
    throw new SafetensorsError("ファイルサイズが safetensors のヘッダーと一致しません（ファイルが壊れているか途中までです）")
  }
  const loraKeys = keys.filter(isLoraKey).length
  const fullKeys = keys.filter(isFullModelKey).length
  const mismatch =
    kind === "LORA" && loraKeys === 0 && fullKeys > 0
      ? "LoRA ではなくチェックポイントのファイルのようです"
      : kind === "CHECKPOINT" && fullKeys === 0 && loraKeys > 0
        ? "チェックポイントではなく LoRA のファイルのようです"
        : null
  if (mismatch) {
    if (strictKind) throw new UserModelError(400, "KIND_MISMATCH", mismatch)
    options.onWarning?.(mismatch)
  }
  return { tensorCount: keys.length }
}

// 流れてくるバイト列をそのまま通しながら safetensors のヘッダーを検証する TransformStream。
// 不正なら stream を error にする（R2 の uploadPart も失敗する）。onError で原因を受け取る。
export const createSafetensorsValidator = (
  totalSize: number,
  kind: UserModelKind,
  onError: (e: UserModelError) => void,
  options: SafetensorsCheckOptions = {},
) => {
  let buffer = new Uint8Array(0)
  let headerLength: number | null = null
  let done = false
  const fail = (controller: TransformStreamDefaultController<Uint8Array>, e: unknown) => {
    const error = e instanceof UserModelError ? e : new SafetensorsError("safetensors の検証に失敗しました")
    onError(error)
    controller.error(error)
  }
  const inspect = () => {
    if (headerLength === null && buffer.length >= 8) {
      const length = new DataView(buffer.buffer, buffer.byteOffset, 8).getBigUint64(0, true)
      if (length === 0n || length > BigInt(Math.min(MAX_SAFETENSORS_HEADER_BYTES, totalSize - 8, USER_MODEL_PART_SIZE - 8))) {
        throw new SafetensorsError("safetensors 形式のファイルではありません")
      }
      headerLength = Number(length)
    }
    if (headerLength !== null && buffer.length > 8 && buffer[8] !== 0x7b) {
      throw new SafetensorsError("safetensors 形式のファイルではありません")
    }
    if (headerLength !== null && buffer.length >= 8 + headerLength) {
      validateSafetensorsHeader(buffer.subarray(8, 8 + headerLength), totalSize, kind, options)
      done = true
      buffer = new Uint8Array(0)
    }
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let offset = 0
      while (!done && offset < chunk.length) {
        // まず先頭 8 バイト、次にヘッダー本体だけを溜める
        const need = headerLength === null ? 8 : 8 + headerLength
        const take = chunk.subarray(offset, offset + (need - buffer.length))
        const merged = new Uint8Array(buffer.length + take.length)
        merged.set(buffer)
        merged.set(take, buffer.length)
        buffer = merged
        offset += take.length
        try {
          inspect()
        } catch (e) {
          fail(controller, e)
          return
        }
      }
      controller.enqueue(chunk)
    },
    flush(controller) {
      if (!done) {
        fail(controller, new SafetensorsError("safetensors のヘッダーが最初のパートに収まっていません"))
      }
    },
  })
}
