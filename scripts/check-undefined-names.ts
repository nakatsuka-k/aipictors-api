// src の多くは @ts-nocheck なので、tsc では import 漏れ（実行時の ReferenceError）に気づけない。
// @ts-nocheck を無視して「名前が見つからない」エラーだけを調べる。
//
//   npx tsx scripts/check-undefined-names.ts
import { readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const ROOT = new URL("..", import.meta.url).pathname
const CANNOT_FIND_NAME = new Set([2304, 2552, 2503, 2305, 2307, 2459, 2614])

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : []
  })

const configPath = join(ROOT, "tsconfig.json")
const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, ROOT)
const host = ts.createCompilerHost(config.options)
const originalRead = host.readFile.bind(host)
const originalGet = host.getSourceFile.bind(host)
const strip = (text: string) => text.replace(/^\/\/ @ts-nocheck.*$/m, "")
host.readFile = (file) => {
  const text = originalRead(file)
  return text !== undefined && file.includes("/src/") ? strip(text) : text
}
host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
  if (!file.includes("/src/")) return originalGet(file, languageVersion, onError, shouldCreate)
  const text = host.readFile(file)
  return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true)
}

const files = [...walk(join(ROOT, "src")), join(ROOT, "worker-configuration.d.ts")]
const program = ts.createProgram(files, { ...config.options, noEmit: true }, host)
const problems = ts
  .getPreEmitDiagnostics(program)
  .filter((d) => CANNOT_FIND_NAME.has(d.code) && d.file?.fileName.includes("/src/"))

for (const d of problems) {
  const { line } = d.file!.getLineAndCharacterOfPosition(d.start!)
  console.log(`${relative(ROOT, d.file!.fileName)}:${line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`)
}
console.log(problems.length === 0 ? "見つからない名前はありません" : `${problems.length} 件`)
process.exit(problems.length > 0 ? 1 : 0)
