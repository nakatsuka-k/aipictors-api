// @ts-nocheck
// DB は Cloudflare D1。表は migrations/gen（コイン・サブスクなど、バインド DB）と migrations/genlog（生成の依頼・結果、バインド GENLOG）で作る。
// 以前の Neon（Postgres）版は Git の履歴にある（feat/task-count-types まで）
import { createD1Client } from "./db-d1"
export var clients = /* @__PURE__ */ new WeakMap();
const clientFor = (binding, name) => {
  if (!binding) {
    throw new Error(`D1 binding ${name} is not configured`);
  }
  let client = clients.get(binding);
  if (!client) {
    client = createD1Client(binding);
    clients.set(binding, client);
  }
  return client;
};
// コイン・サブスク・サポート・ユーザーモデルなど
export var getDb = async (env) => clientFor(env.DB, "DB");
// 生成の依頼・結果・予約（大きいので別の D1）
export var getGenlogDb = async (env) => clientFor(env.GENLOG, "GENLOG");
// コイン操作用のロックキー（D1 では使わないが呼び出し側の互換のため残す）
export var coinLockKey = (userId) => `coins:${userId}`;
export var getNow = () => Math.floor(Date.now() / 1e3);
