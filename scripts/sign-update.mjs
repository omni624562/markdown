#!/usr/bin/env node
/**
 * 自動更新的簽章：用 Ed25519 私鑰簽 version.json 中的重要欄位，程式更新前用內建的公鑰驗證。
 * 這樣即使有人能改 GitHub 上的 Release 檔案（例如權杖外洩），沒有私鑰也做不出程式會接受的更新。
 *
 *   UPDATE_SIGNING_KEY=<私鑰> node scripts/sign-update.mjs version.json   在 version.json 加上 signature
 *
 * 私鑰是 PKCS#8 DER 的 base64（一行），放在 GitHub 的 Actions secret「UPDATE_SIGNING_KEY」。
 * 簽章的內容要和 desktop/src/update.rs 的 `signed_message` 完全一致。
 */
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 要簽章的內容：版本、流水號、下載網址、檢查碼與大小，一行一個。 */
export function signedMessage(m) {
  return ["md-editor-update/v1", m.build, m.version, m.url, m.sha256.toLowerCase(), m.size].join("\n");
}

export function signManifest(manifest, keyBase64) {
  const key = createPrivateKey({ key: Buffer.from(keyBase64.trim(), "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(signedMessage(manifest)), key).toString("base64");
  return { ...manifest, signature };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const file = process.argv[2];
  const key = process.env.UPDATE_SIGNING_KEY;
  if (!file) {
    console.error(`用法：UPDATE_SIGNING_KEY=… node ${fileURLToPath(import.meta.url)} version.json`);
    process.exit(1);
  }
  if (!key) {
    console.error(
      "✗ 沒有設定 UPDATE_SIGNING_KEY。請在 GitHub 儲存庫的 Settings → Secrets and variables → Actions 新增這個 secret（內容是簽章私鑰），否則程式不會接受這次的更新。",
    );
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify(signManifest(manifest, key), null, 2)}\n`);
  console.log("✓ 已簽章");
}
