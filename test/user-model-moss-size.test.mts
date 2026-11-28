// MOSS Image のチェックポイントの判定と、プランごとの 1 ファイルの上限: npx tsx test/user-model-moss-size.test.mts
import assert from "node:assert/strict"

const { validateSafetensorsHeader, isMossCheckpointKeys } = await import(
  new URL("../src/lib/user-models/safetensors.ts", import.meta.url).pathname
)
const { userModelMaxBytes, userModelTooLargeMessage, defaultUserModelMaxBytes, defaultSubscriberCheckpointMaxBytes } =
  await import(new URL("../src/lib/user-models/common.ts", import.meta.url).pathname)
const { mapCivitaiBaseModel } = await import(new URL("../src/lib/user-model-imports.ts", import.meta.url).pathname)

const header = (keys: string[]) => {
  const json: Record<string, unknown> = {}
  keys.forEach((key, i) => {
    json[key] = { dtype: "BF16", shape: [1], data_offsets: [i * 2, i * 2 + 2] }
  })
  const bytes = new TextEncoder().encode(JSON.stringify(json))
  return { bytes, total: 8 + bytes.length + keys.length * 2 }
}

// cocoamixMoss01_bf16 と同じ形（ComfyUI 向けの書き出し、接頭辞なし）
const mossKeys = [
  "final_linear_video.weight",
  "layers.0.proj.o.weight",
  "shared_block_modulation.weight",
  "text_embedder.proj.weight",
  "video_embedder.weight",
]
const sdxlKeys = ["model.diffusion_model.input_blocks.0.0.weight", "conditioner.embedders.1.model.ln_final.weight"]

assert.equal(isMossCheckpointKeys(mossKeys), true)
assert.equal(isMossCheckpointKeys(mossKeys.map((k) => `model.diffusion_model.${k}`)), true)
assert.equal(isMossCheckpointKeys(sdxlKeys), false)

{
  const h = header(mossKeys)
  assert.equal(validateSafetensorsHeader(h.bytes, h.total, "CHECKPOINT", { baseModel: "MOSS" }).isMoss, true)
  // 系統が分からないものは通す（生成側がファイルの中身で MOSS と判定する）
  assert.equal(validateSafetensorsHeader(h.bytes, h.total, "CHECKPOINT", { baseModel: "OTHER" }).isMoss, true)
  assert.throws(
    () => validateSafetensorsHeader(h.bytes, h.total, "CHECKPOINT", { baseModel: "ILLUSTRIOUS" }),
    (e: { code?: string }) => e.code === "BASE_MODEL_MISMATCH",
  )
}
{
  const h = header(sdxlKeys)
  assert.throws(
    () => validateSafetensorsHeader(h.bytes, h.total, "CHECKPOINT", { baseModel: "MOSS" }),
    (e: { code?: string }) => e.code === "BASE_MODEL_MISMATCH",
  )
  assert.equal(validateSafetensorsHeader(h.bytes, h.total, "CHECKPOINT", { baseModel: "SDXL" }).isMoss, false)
}

const settings = { maxBytes: { ...defaultUserModelMaxBytes }, subscriberCheckpointMaxBytes: defaultSubscriberCheckpointMaxBytes }
const GB = 1024 ** 3
assert.equal(userModelMaxBytes(settings, "CHECKPOINT", "FREE"), Math.floor(7.5 * GB))
for (const plan of ["LITE", "STANDARD", "PREMIUM"]) {
  assert.equal(userModelMaxBytes(settings, "CHECKPOINT", plan), 10 * GB)
}
// LoRA はプランで変わらない
assert.equal(userModelMaxBytes(settings, "LORA", "PREMIUM"), 400 * 1024 * 1024)
// cocoamixMoss01_bf16（10,164,655,824 バイト）はサブスクなら入る
assert.ok(10_164_655_824 <= userModelMaxBytes(settings, "CHECKPOINT", "LITE"))
assert.ok(10_164_655_824 > userModelMaxBytes(settings, "CHECKPOINT", "FREE"))
assert.equal(
  userModelTooLargeMessage(settings, "CHECKPOINT", "FREE"),
  "チェックポイント は 7.5GB までです（サブスクに加入すると 10GB まで登録できます）",
)
assert.equal(userModelTooLargeMessage(settings, "CHECKPOINT", "PREMIUM"), "チェックポイント は 10GB までです")
assert.equal(userModelTooLargeMessage(settings, "LORA", "FREE"), "LoRA は 400MB までです")

assert.equal(mapCivitaiBaseModel("MOSS Image"), "MOSS")
assert.equal(mapCivitaiBaseModel("Illustrious"), "ILLUSTRIOUS")
assert.equal(mapCivitaiBaseModel("Flux.1 D"), "OTHER")

console.log("ok")
