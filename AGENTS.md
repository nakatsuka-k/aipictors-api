# aipictors-api

Hono + Cloudflare Workers + Neon Postgres の内部 API。この文書は 2026-11-04 に確認した内容。

## 本番の元

- 2026-11-04 時点で本番は Worker version `1615ae18`（11/03 03:31:49 JST）。元は `feat/gemini-daily-limit` の 663b890（同 03:31:40 JST）で、時刻とメモから対応づけた。
- `origin/main` は 663b890 の祖先で、24 コミット遅れている。
- `.github/workflows/deploy.yml` は main への push で `wrangler deploy` する。main に入れると本番に出る。ここ最近の本番は main ではなくブランチから deploy されている。
- 今の版は `npx wrangler deployments list` で見る。

## テスト

```sh
npm run check           # tsc（src の多くは @ts-nocheck なので、これだけでは足りない）
npm run check:names     # @ts-nocheck を無視して import 漏れを調べる
npm test                # test/*.mts をすべて実行。埋め込みの Postgres を使い、本番にはつながらない
npm run compare:logic   # 663b890 とトップレベルの文ごとに比較
```

- `test/fixtures/api-golden.json` と `routes.json` は 663b890 の応答とルート一覧。応答を意図して変えたときだけ `UPDATE_GOLDEN=1 npx tsx test/api-golden.pg-test.mts` で作り直す。
- `test/fixtures/image-generation-schema.sql` は本番のテーブル定義（データなし）。

## デプロイ

```sh
npx wrangler deploy --dry-run --outdir /tmp/aipictors-api-dry-run   # バンドルの確認（デプロイしない）
npx wrangler deploy
```

- `schemaStatements`（`src/lib/db.ts`）を変えると `SCHEMA_VERSION` が変わり、次のリクエストで DDL がすべて流れる。インデックスの追加は先に本番で別途作ってから入れる。
- カスタムドメインは wrangler.toml ではなく Dashboard で設定している（wrangler.toml のコメントより）。

## 戻し方

```sh
npx wrangler deployments list        # 戻し先の version を確認
npx wrangler rollback <version-id>
```

DDL は戻らない。

## 構成

- `src/index.ts`: Worker の入口と cron。`src/app.ts`: ルートの組み立て。`src/routes/`: ルート。`src/lib/`: 処理。
- `lib/coins.ts`、`lib/coin-support.ts`、`lib/user-models.ts` は同名のディレクトリへの再 export。中身はディレクトリ側を直す。
- Neon は 1 文ごとに HTTP の往復になる。互いに依存しない読み取りは `Promise.all` で同時に投げる。
