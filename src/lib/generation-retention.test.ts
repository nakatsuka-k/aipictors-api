// @ts-nocheck
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isExpired, RETENTION_ENFORCE_FROM, toGenerativeFileKey } from "./generation-retention";

const expect = (value) => ({
  toBe: (expected) => assert.strictEqual(value, expected),
  toBeNull: () => assert.strictEqual(value, null),
});

const uuid = "300001c9-1635-2967-4f9f-9a87089bb81a";
const now = Date.parse("2027-06-01T00:00:00Z");
const row = (generation_time, extra = {}) => ({ generation_time, is_deleted: 0, is_protected: 0, ...extra });

describe("isExpired", () => {
  it("プランごとの期限で判定する", () => {
    const fourMonths = row("2027-02-01 00:00:00");
    expect(isExpired({ row: fourMonths, plan: undefined, nowMs: now, enforce: true })).toBe(true);
    expect(isExpired({ row: fourMonths, plan: "LITE", nowMs: now, enforce: true })).toBe(false);
    const eightMonths = row("2026-10-01 00:00:00");
    expect(isExpired({ row: eightMonths, plan: "LITE", nowMs: now, enforce: true })).toBe(true);
    expect(isExpired({ row: eightMonths, plan: "STANDARD", nowMs: now, enforce: true })).toBe(false);
    const eighteenMonths = row("2025-12-01 00:00:00");
    expect(isExpired({ row: eighteenMonths, plan: "STANDARD", nowMs: now, enforce: true })).toBe(true);
    expect(isExpired({ row: eighteenMonths, plan: "PREMIUM", nowMs: now, enforce: true })).toBe(false);
  });

  it("保護した画像は消さない", () => {
    const old = row("2020-01-01 00:00:00", { is_protected: 1, is_deleted: 1 });
    expect(isExpired({ row: old, plan: undefined, nowMs: now, enforce: true })).toBe(false);
  });

  it("開始日までは利用者が消した分だけ対象にする", () => {
    const old = row("2020-01-01 00:00:00");
    const before = RETENTION_ENFORCE_FROM - 1;
    expect(isExpired({ row: old, plan: undefined, nowMs: before, enforce: false })).toBe(false);
    expect(isExpired({ row: { ...old, is_deleted: 1 }, plan: undefined, nowMs: before, enforce: false })).toBe(true);
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
