// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { json } from "./json"
export var toHex = (bytes) => {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
export var getTokenFingerprint = async (token) => {
  if (!token) {
    return null;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return toHex(new Uint8Array(digest)).slice(0, 12);
};
export var getBearer = (c) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
};
export var getInternalApiToken = (c) => {
  return c.env.INTERNAL_API_TOKEN ?? c.env.AIPICTORS_API_INTERNAL_TOKEN ?? null;
};
export var getAdminApiToken = (c) => {
  return c.env.ADMIN_API_TOKEN ?? c.env.AIPICTORS_API_ADMIN_TOKEN ?? null;
};
export var requireInternalAuth = async (c, next) => {
  const token = getBearer(c);
  const expected = getInternalApiToken(c);
  if (!expected || token !== expected) {
    const providedFingerprint = await getTokenFingerprint(token);
    const expectedFingerprint = await getTokenFingerprint(expected);
    console.warn("internal auth rejected", {
      path: c.req.path,
      hasExpectedToken: Boolean(expected),
      providedFingerprint,
      expectedFingerprint
    });
    const debugError = [
      "Unauthorized",
      `hasExpected=${Boolean(expected)}`,
      `providedFp=${providedFingerprint ?? "null"}`,
      `expectedFp=${expectedFingerprint ?? "null"}`
    ].join(";");
    return json({ error: debugError }, 401);
  }
  await next();
};
export var requireAdminAuth = async (c, next) => {
  const token = getBearer(c);
  const expected = getAdminApiToken(c);
  if (!expected || token !== expected) {
    return json({ error: "Unauthorized" }, 401);
  }
  await next();
};
