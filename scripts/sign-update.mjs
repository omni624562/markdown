#!/usr/bin/env node
/**
 * 自動更新的簽章：用 Ed25519 私鑰簽 version.json 中的重要欄位，程式更新前用內建的公鑰驗證。
 * 這樣即使有人能改 GitHub 上的 Release 檔案（例如權杖外洩），沒有私鑰也做不出程式會接受的更新。
 *
 *   UPDATE_SIGNING_KEY=<私鑰> node scripts/sign-update.mjs version.json   在 version.json 加上 signature
 *
 * 私鑰是 PKCS#8 DER 的 base64（一行），放在 GitHub 的 Actions secret「UPDATE_SIGNING_KEY」。
 * 簽章的內容要和 desktop/src/update.rs 的 `signed_message` 完全一致。
 *
 * 有兩種簽章：`signature`（v1，1.62.0 以前的版本驗證這個）與 `signatureV2`（v2，之後的版本驗證這個）。
 * v2 另外簽了發佈時間、提交、日期，以及說明文字（`notes`、`changes`）的 SHA-256，
 * 更新視窗顯示的說明也不能被改掉。
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 要簽章的內容：版本、流水號、下載網址、檢查碼與大小，一行一個。 */
export function signedMessage(m) {
  return ["md-editor-update/v1", m.build, m.version, m.url, m.sha256.toLowerCase(), m.size].join("\n");
}

const sha256 = (text) => createHash("sha256").update(text ?? "", "utf8").digest("hex");

/** v2 的簽章內容（desktop/src/update.rs 的 `signed_message_v2`）。 */
export function signedMessageV2(m) {
  return [
    "md-editor-update/v2",
    m.build,
    m.version,
    m.url,
    m.sha256.toLowerCase(),
    m.size,
    m.issued,
    m.commit ?? "",
    m.date ?? "",
    sha256(m.notes),
    sha256(m.changes),
  ].join("\n");
}

export function signManifest(manifest, keyBase64, now = new Date()) {
  const key = createPrivateKey({ key: Buffer.from(keyBase64.trim(), "base64"), format: "der", type: "pkcs8" });
  const m = { ...manifest, issued: manifest.issued ?? now.toISOString() };
  const signature = sign(null, Buffer.from(signedMessage(m)), key).toString("base64");
  const signatureV2 = sign(null, Buffer.from(signedMessageV2(m)), key).toString("base64");
  return { ...m, signature, signatureV2 };
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
