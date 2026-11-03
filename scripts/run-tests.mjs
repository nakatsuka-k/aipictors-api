// npm test: test/ のテストを順に実行する（Postgres のテストは埋め込みの Postgres を使うので本番 DB にはつながらない）
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const only = process.argv.slice(2)
const files = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".mts"))
  .filter((name) => only.length === 0 || only.some((word) => name.includes(word)))
  .sort()

let failed = 0
for (const file of files) {
  const started = Date.now()
  const result = spawnSync("npx", ["tsx", join("test", file)], { cwd: root, encoding: "utf8" })
  const ok = result.status === 0
  console.log(`${ok ? "ok  " : "FAIL"} ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  if (!ok) {
    failed++
    console.log(result.stdout.split("\n").slice(-30).join("\n"))
    console.log(result.stderr.split("\n").slice(-30).join("\n"))
  }
}
process.exit(failed > 0 ? 1 : 0)
