import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { signManifest, signedMessage, signedMessageV2 } from "./sign-update.mjs";

const manifest = {
  build: 123,
  version: "1.1.0",
  commit: "abc1234",
  date: "2026-10-20",
  notes: "修正",
  changes: "### 修正\n\n- 某個問題",
  url: "https://github.com/omni624562/markdown/releases/download/latest/omarker.exe",
  sha256: "AB".repeat(32),
  size: 4096,
};

test("兩種簽章都驗證得過，v2 連說明文字也簽了", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const signed = signManifest(manifest, key, new Date("2026-10-30T00:00:00Z"));
  assert.equal(signed.issued, "2026-10-30T00:00:00.000Z");
  const ok = (message, sig) => verify(null, Buffer.from(message), publicKey, Buffer.from(sig, "base64"));
  assert.ok(ok(signedMessage(signed), signed.signature));
  assert.ok(ok(signedMessageV2(signed), signed.signatureV2));
  assert.ok(!ok(signedMessageV2({ ...signed, notes: "請改下載 evil.exe" }), signed.signatureV2));
  assert.ok(!ok(signedMessageV2({ ...signed, issued: "2020-01-01T00:00:00.000Z" }), signed.signatureV2));
  // v1 不含說明文字：舊版程式照常驗證。
  assert.ok(ok(signedMessage({ ...signed, notes: "其他" }), signed.signature));
});

test("已經有發佈時間時沿用", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  assert.equal(signManifest({ ...manifest, issued: "x" }, key).issued, "x");
});
