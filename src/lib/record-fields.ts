// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// Stripe などの JSON 応答から型を確かめて値を取り出す
export var getString = (record, key) => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};
export var getNumber = (record, key) => {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
export var getRecord = (record, key) => {
  const value = record[key];
  return typeof value === "object" && value !== null ? value : null;
};
export var getArray = (record, key) => {
  const value = record[key];
  return Array.isArray(value) ? value : [];
};
