// isolate の中で 1 回だけ実行する（Neon は 1 文ごとに HTTP の往復なので、CREATE ... IF NOT EXISTS を毎リクエスト流さない）。
// 失敗したら次のリクエストでやり直す
export const oncePerDb = <Db extends object>(run: (db: Db) => Promise<void>) => {
  const done = new WeakMap<Db, Promise<void>>()
  return (db: Db) => {
    let ready = done.get(db)
    if (!ready) {
      ready = run(db)
      done.set(db, ready)
      ready.catch(() => done.delete(db))
    }
    return ready
  }
}
