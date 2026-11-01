// おすすめ設定の自動作成: npx tsx test/user-model-recommendations.test.mts
import assert from "node:assert/strict"

const { deriveRecommendedSettings, normalizeSampler, normalizeScheduler, splitPromptTags } = await import(
  new URL("../src/lib/user-model-recommendations.ts", import.meta.url).pathname
)

assert.deepEqual(normalizeSampler("DPM++ 2M Karras"), { sampler: "DPM++ 2M", scheduler: "Karras" })
assert.deepEqual(normalizeSampler("er_sde_beta"), { sampler: "ER SDE", scheduler: "Beta" })
assert.deepEqual(normalizeSampler("Euler a"), { sampler: "Euler a", scheduler: null })
assert.deepEqual(normalizeSampler("euler_ancestral"), { sampler: "Euler a", scheduler: null })
assert.deepEqual(normalizeSampler("unknown sampler"), { sampler: null, scheduler: null })
assert.equal(normalizeScheduler("sgm_uniform"), "SGM Uniform")
assert.equal(normalizeScheduler("Automatic"), null)

assert.deepEqual(splitPromptTags("(masterpiece:1.2), Best Quality,\n<lora:x:1>, BREAK solo, embedding:foo"), [
  "masterpiece",
  "best quality",
  "solo",
])

const meta = (extra: Record<string, unknown>) => ({
  sampler: "Euler a",
  cfgScale: 5,
  steps: 28,
  clipSkip: 2,
  prompt: "masterpiece, best quality, 1girl, giant explicit tag",
  negativePrompt: "lowres, bad anatomy, loli, sex",
  ...extra,
})

// 集計: 多数派を選ぶ。品質タグは決まった語だけ。ネガティブから性的・年齢の語を外す
{
  const settings = deriveRecommendedSettings({
    baseModel: "ILLUSTRIOUS",
    metas: [meta({}), meta({}), meta({}), meta({ sampler: "DPM++ 2M Karras", cfgScale: 7 })],
  })
  assert.equal(settings.sampler, "Euler a")
  assert.equal(settings.cfgScale, 5)
  assert.equal(settings.source, "civitai")
  assert.equal(settings.sampleCount, 4)
  assert.equal(settings.qualityPrompt, "masterpiece, best quality")
  assert.equal(settings.negativePrompt, "lowres, bad anatomy")
}

// lightning 向けの作例が混ざっても、Steps は多数派の CFG の作例で見る
{
  const settings = deriveRecommendedSettings({
    baseModel: "ILLUSTRIOUS",
    metas: [
      meta({ cfgScale: 5, steps: 30 }),
      meta({ cfgScale: 5, steps: 30 }),
      meta({ cfgScale: 5, steps: 30 }),
      meta({ cfgScale: 1, steps: 4 }),
      meta({ cfgScale: 1, steps: 4 }),
    ],
  })
  assert.equal(settings.cfgScale, 5)
  assert.equal(settings.steps, 30)
}

// 範囲: Steps は 4〜30、CFG は四捨五入
{
  const settings = deriveRecommendedSettings({
    baseModel: "OTHER",
    metas: [meta({ steps: 48, cfgScale: 4.5 }), meta({ steps: 48, cfgScale: 4.5 }), meta({ steps: 48, cfgScale: 4.5 })],
  })
  assert.equal(settings.steps, 30)
  assert.equal(settings.cfgScale, 5)
}

// 作例が足りない: ベースモデルの定番。未対応のベースモデルは null
{
  const pony = deriveRecommendedSettings({ baseModel: "PONY", metas: [meta({})] })
  assert.equal(pony.source, "base-model")
  assert.match(pony.qualityPrompt, /^score_9/)
  assert.equal(deriveRecommendedSettings({ baseModel: "OTHER", metas: [] }), null)
}

// 品質タグが作例に少なければ定番で補う
{
  const settings = deriveRecommendedSettings({
    baseModel: "ILLUSTRIOUS",
    metas: [meta({ prompt: "1girl" }), meta({ prompt: "1girl" }), meta({ prompt: "1girl" })],
  })
  assert.match(settings.qualityPrompt, /masterpiece/)
  assert.equal(settings.source, "civitai")
  // ネガティブも少なければ定番を足す（作例のものが先）
  assert.match(settings.negativePrompt, /^lowres, bad anatomy, worst quality/)
}

console.log("ok")
