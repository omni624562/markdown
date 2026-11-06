import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LEGACY_PUBLIC_KEY, programPublicKey, publicKeyOf, signManifest, signedMessage, signedMessageV2 } from "./sign-update.mjs";

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

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, key: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
}

const ok = (publicKey, message, sig) => verify(null, Buffer.from(message), publicKey, Buffer.from(sig, "base64"));

test("新金鑰簽 signatureKey2；舊金鑰另外簽 signature、signatureV2 給還沒換金鑰的舊版本", () => {
  const current = keyPair();
  const legacy = keyPair();
  const signed = signManifest(manifest, { current: current.key, legacy: legacy.key }, new Date("2026-10-30T00:00:00Z"));
  assert.equal(signed.issued, "2026-10-30T00:00:00.000Z");
  assert.ok(ok(current.publicKey, signedMessageV2(signed), signed.signatureKey2));
  assert.ok(ok(legacy.publicKey, signedMessage(signed), signed.signature));
  assert.ok(ok(legacy.publicKey, signedMessageV2(signed), signed.signatureV2));
  // 舊金鑰的簽章不是新金鑰簽的，反之亦然。
  assert.ok(!ok(legacy.publicKey, signedMessageV2(signed), signed.signatureKey2));
  assert.ok(!ok(current.publicKey, signedMessageV2(signed), signed.signatureV2));
  // v2 連說明文字、發佈時間也簽了；v1 不含說明文字，舊版程式照常驗證。
  assert.ok(!ok(current.publicKey, signedMessageV2({ ...signed, notes: "請改下載 evil.exe" }), signed.signatureKey2));
  assert.ok(!ok(current.publicKey, signedMessageV2({ ...signed, issued: "2020-01-01T00:00:00.000Z" }), signed.signatureKey2));
  assert.ok(ok(legacy.publicKey, signedMessage({ ...signed, notes: "其他" }), signed.signature));
});

test("沒有舊金鑰時只簽新金鑰，也不留下原本的舊簽章", () => {
  const current = keyPair();
  const signed = signManifest({ ...manifest, signature: "舊的", signatureV2: "舊的" }, { current: current.key });
  assert.equal(signed.signature, undefined);
  assert.equal(signed.signatureV2, undefined);
  assert.ok(ok(current.publicKey, signedMessageV2(signed), signed.signatureKey2));
  assert.throws(() => signManifest(manifest, {}), /UPDATE_SIGNING_KEY_2/);
});

test("金鑰和預期的公鑰對不上時不簽", () => {
  const current = keyPair();
  const legacy = keyPair();
  const expect = { current: publicKeyOf(current.key), legacy: publicKeyOf(legacy.key) };
  assert.ok(signManifest(manifest, { current: current.key, legacy: legacy.key }, new Date(), expect).signatureKey2);
  // 新金鑰放錯（例如把舊金鑰放進 UPDATE_SIGNING_KEY_2）：新版程式不會接受，所以不簽。
  assert.throws(() => signManifest(manifest, { current: legacy.key, legacy: legacy.key }, new Date(), expect), /UPDATE_PUBLIC_KEY/);
  assert.throws(() => signManifest(manifest, { current: current.key, legacy: current.key }, new Date(), expect), /舊版程式/);
});

test("公鑰的格式和程式內建的一樣；程式內建的是新金鑰，不是舊金鑰", () => {
  const { publicKey, key } = keyPair();
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  assert.equal(publicKeyOf(key), raw);
  assert.equal(raw.length, 44);
  const program = programPublicKey(readFileSync(new URL("../desktop/src/update.rs", import.meta.url), "utf8"));
  assert.equal(program.length, 44);
  assert.notEqual(program, LEGACY_PUBLIC_KEY);
  assert.throws(() => programPublicKey("fn main() {}"), /UPDATE_PUBLIC_KEY/);
});

test("已經有發佈時間時沿用", () => {
  assert.equal(signManifest({ ...manifest, issued: "x" }, { current: keyPair().key }).issued, "x");
});
