// @ts-nocheck
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RETENTION_ENFORCE_FROM, toGenerativeFileKey, toRetentionAction } from "./generation-retention";

const expect = (value) => ({
  toBe: (expected) => assert.strictEqual(value, expected),
  toBeNull: () => assert.strictEqual(value, null),
});

const uuid = "300001c9-1635-2967-4f9f-9a87089bb81a";
const now = Date.parse("2027-06-01T00:00:00Z");
const row = (generation_time, extra = {}) => ({ generation_time, is_deleted: 0, is_protected: 0, ...extra });

describe("toRetentionAction", () => {
  const image = { image_url: `https://generative-files.aipictors.com/${uuid}`, thumbnail_image_url: "" };
  const act = (generation_time, plan, extra = {}, nowMs = now) =>
    toRetentionAction({ row: row(generation_time, { ...image, ...extra }), plan, nowMs, enforce: nowMs >= RETENTION_ENFORCE_FROM });

  it("プランの期限から 30 日たってから画像だけ消す", () => {
    // 無料 90 日: 2027-06-01 の時点で 2027-02-01 生成は 120 日（期限 + 猶予を過ぎた）、2027-02-10 生成はまだ猶予中
    expect(act("2027-02-01 00:00:00", undefined)).toBe("clear");
    expect(act("2027-02-10 00:00:00", undefined)).toBeNull();
    expect(act("2027-02-01 00:00:00", "LITE")).toBeNull();
    expect(act("2026-10-01 00:00:00", "LITE")).toBe("clear");
    expect(act("2026-10-01 00:00:00", "STANDARD")).toBeNull();
    expect(act("2025-12-01 00:00:00", "STANDARD")).toBe("clear");
    expect(act("2025-12-01 00:00:00", "PREMIUM")).toBeNull();
  });

  it("消し始める日より前に期限が来たものは、その日から 30 日残す", () => {
    const jan15 = Date.parse("2027-01-15T00:00:00Z");
    const feb15 = Date.parse("2027-02-15T00:00:00Z");
    expect(act("2025-01-01 00:00:00", undefined, {}, jan15)).toBeNull();
    expect(act("2025-01-01 00:00:00", undefined, {}, feb15)).toBe("clear");
  });

  it("保護した画像・画像を消した行はそのまま、利用者が消した行は行ごと消す", () => {
    expect(act("2020-01-01 00:00:00", undefined, { is_protected: 1, is_deleted: 1 })).toBeNull();
    expect(act("2020-01-01 00:00:00", undefined, { image_url: "", thumbnail_image_url: "" })).toBeNull();
    expect(act("2027-05-30 00:00:00", undefined, { is_deleted: 1 })).toBe("delete");
  });

  it("開始日までは利用者が消した分だけ対象にする", () => {
    const before = RETENTION_ENFORCE_FROM - 1;
    expect(act("2020-01-01 00:00:00", undefined, {}, before)).toBeNull();
    expect(act("2020-01-01 00:00:00", undefined, { is_deleted: 1 }, before)).toBe("delete");
  });
});

describe("toGenerativeFileKey", () => {
  it("生成画像の URL だけをキーにする", () => {
    expect(toGenerativeFileKey(`https://generative-files.aipictors.com/${uuid}`)).toBe(uuid);
    expect(toGenerativeFileKey(`https://generative.files.aipictors.com/${uuid}.thumbnail?x=1`)).toBe(`${uuid}.thumbnail`);
    expect(toGenerativeFileKey(`https://files.aipictors.com/${uuid}`)).toBeNull();
    expect(toGenerativeFileKey("https://generative-files.aipictors.com/sample.png")).toBeNull();
    expect(toGenerativeFileKey(null)).toBeNull();
  });
});
