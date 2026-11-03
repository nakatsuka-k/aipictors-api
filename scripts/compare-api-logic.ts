// 基準のコミットと今の src を、トップレベルの文（関数・定数・型・ルート登録）ごとにトークン列で比べる。
// コメント・空白・ファイルの場所・export の有無は無視する。
//
//   npx tsx scripts/compare-api-logic.ts [基準のコミット。既定 663b890]
//
// 基準の文がすべて今の src にあれば終了コード 0。意図して変えたものは EXPECTED_CHANGES に理由つきで書く。
import { execSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const ROOT = new URL("..", import.meta.url).pathname
const BASE = process.argv[2] ?? "663b890"

// 名前 → 理由。名前のない文（ルート登録など）は先頭 60 文字
const EXPECTED_CHANGES: Record<string, string> = {}

const tokens = (node: ts.Node, sf: ts.SourceFile): string[] => {
  const out: string[] = []
  const visit = (n: ts.Node) => {
    const children = n.getChildren(sf)
    if (children.length === 0) {
      if (n.kind !== ts.SyntaxKind.EndOfFileToken && n.getWidth(sf) > 0) out.push(n.getText(sf))
      return
    }
    children.forEach(visit)
  }
  visit(node)
  return out
}

type Unit = { name: string; file: string; normalized: string }

const unitsOf = (file: string, text: string): Unit[] => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  const units: Unit[] = []
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) continue
    let name = s.getText(sf).replace(/\s+/g, " ").slice(0, 60)
    if (ts.isVariableStatement(s)) name = s.declarationList.declarations.map((d) => d.name.getText(sf)).join(",")
    else if ((ts.isTypeAliasDeclaration(s) || ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s)) && s.name) name = s.name.text
    const list = tokens(s, sf)
    if (list[0] === "export") list.shift()
    units.push({ name, file, normalized: list.join(" ") })
  }
  return units
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : []
  })

const baseFiles = execSync(`git ls-tree -r --name-only ${BASE} src`, { cwd: ROOT }).toString().trim().split("\n").filter((f) => f.endsWith(".ts"))
const before = baseFiles.flatMap((file) =>
  unitsOf(file, execSync(`git show ${BASE}:${file}`, { cwd: ROOT, maxBuffer: 1e8 }).toString()),
)
const after = walk(join(ROOT, "src")).flatMap((path) => unitsOf(relative(ROOT, path), readFileSync(path, "utf8")))

const remaining = new Map<string, number>()
for (const unit of after) remaining.set(unit.normalized, (remaining.get(unit.normalized) ?? 0) + 1)

let same = 0
const changed: Unit[] = []
for (const unit of before) {
  const left = remaining.get(unit.normalized) ?? 0
  if (left > 0) {
    remaining.set(unit.normalized, left - 1)
    same++
  } else {
    changed.push(unit)
  }
}

console.log(`基準 ${BASE}: トップレベルの文 ${before.length} 個`)
console.log(`  同じ: ${same}`)
let unexpected = 0
for (const unit of changed) {
  const reason = EXPECTED_CHANGES[unit.name]
  if (reason) {
    console.log(`  意図した変更: ${unit.name}（${unit.file}）— ${reason}`)
  } else {
    unexpected++
    console.log(`  違う: ${unit.name}（${unit.file}）`)
  }
}
process.exit(unexpected > 0 ? 1 : 0)
