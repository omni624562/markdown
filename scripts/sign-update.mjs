#!/usr/bin/env node
/**
 * 自動更新的簽章：用 Ed25519 私鑰簽 version.json 中的重要欄位，程式更新前用內建的公鑰驗證。
 * 這樣即使有人能改 GitHub 上的 Release 檔案（例如權杖外洩），沒有私鑰也做不出程式會接受的更新。
 *
 *   UPDATE_SIGNING_KEY_2=<新私鑰> UPDATE_SIGNING_KEY=<舊私鑰> node scripts/sign-update.mjs version.json
 *
 * 私鑰是 PKCS#8 DER 的 base64（一行），放在 GitHub `release` 環境的 secret。
 * 簽章的內容要和 desktop/src/update.rs 的 `signed_message_v2` 完全一致。
 *
 * 換過一次金鑰，所以有兩把：
 * - 新金鑰（`UPDATE_SIGNING_KEY_2`，一定要有）簽 `signatureKey2`，換金鑰之後的版本只驗證這個。
 *   簽之前確認它和 desktop/src/update.rs 的 `UPDATE_PUBLIC_KEY` 是一對，對不上就不簽：
 *   否則發佈出去的更新，新版程式全部不接受，之後再也更新不了。
 * - 舊金鑰（`UPDATE_SIGNING_KEY`，過渡期間才有）簽 `signature`（v1，1.62.0 以前的版本驗證）與
 *   `signatureV2`（v2，1.62.0 到 1.131.1 的版本驗證），讓還沒更新的舊版本照常更新上來。
 *   大家都更新之後，刪掉這個 secret 就不再用舊金鑰簽章。
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 舊金鑰的公鑰（1.131.1 以前的版本內建的），確認 `UPDATE_SIGNING_KEY` 沒有放錯。 */
export const LEGACY_PUBLIC_KEY = "jrj/RFTEfLoSMPa3Bi+GMm6qhgOTyx7DbeGvNdsg08E=";

/** v1 的簽章內容：版本、流水號、下載網址、檢查碼與大小，一行一個。 */
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

const privateKey = (base64) => createPrivateKey({ key: Buffer.from(base64.trim(), "base64"), format: "der", type: "pkcs8" });

/** 私鑰對應的公鑰（32 位元組，base64），格式和 update.rs 的 `UPDATE_PUBLIC_KEY` 一樣。 */
export function publicKeyOf(keyBase64) {
  return createPublicKey(privateKey(keyBase64)).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
}

/** desktop/src/update.rs 內建的公鑰。 */
export function programPublicKey(source) {
  const found = /const UPDATE_PUBLIC_KEY: &str = "([^"]+)";/.exec(source);
  if (!found) throw new Error("在 desktop/src/update.rs 找不到 UPDATE_PUBLIC_KEY");
  return found[1];
}

/**
 * 簽章。`keys.current` 是新金鑰（簽 `signatureKey2`），`keys.legacy` 是舊金鑰（簽 `signature`、`signatureV2`，可以省略）。
 * `expect` 是兩把金鑰各自應該對應的公鑰；給了就先核對，對不上時丟出錯誤、不簽。
 */
export function signManifest(manifest, keys, now = new Date(), expect = {}) {
  if (!keys.current) throw new Error("沒有新金鑰（UPDATE_SIGNING_KEY_2）");
  if (expect.current && publicKeyOf(keys.current) !== expect.current) {
    throw new Error("UPDATE_SIGNING_KEY_2 和程式內建的公鑰（desktop/src/update.rs 的 UPDATE_PUBLIC_KEY）不是一對");
  }
  if (keys.legacy && expect.legacy && publicKeyOf(keys.legacy) !== expect.legacy) {
    throw new Error("UPDATE_SIGNING_KEY 不是舊版程式內建的那把金鑰");
  }
  const { signature: _v1, signatureV2: _v2, signatureKey2: _k2, ...rest } = manifest;
  const m = { ...rest, issued: manifest.issued ?? now.toISOString() };
  const signed = { ...m };
  if (keys.legacy) {
    const legacy = privateKey(keys.legacy);
    signed.signature = sign(null, Buffer.from(signedMessage(m)), legacy).toString("base64");
    signed.signatureV2 = sign(null, Buffer.from(signedMessageV2(m)), legacy).toString("base64");
  }
  signed.signatureKey2 = sign(null, Buffer.from(signedMessageV2(m)), privateKey(keys.current)).toString("base64");
  return signed;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const file = process.argv[2];
  const current = process.env.UPDATE_SIGNING_KEY_2;
  const legacy = process.env.UPDATE_SIGNING_KEY;
  if (!file) {
    console.error(`用法：UPDATE_SIGNING_KEY_2=… [UPDATE_SIGNING_KEY=…] node ${fileURLToPath(import.meta.url)} version.json`);
    process.exit(1);
  }
  if (!current) {
    console.error(
      "✗ 沒有設定 UPDATE_SIGNING_KEY_2。請在 GitHub 儲存庫的 Settings → Environments → release 新增這個 secret（內容是新的簽章私鑰），否則程式不會接受這次的更新。",
    );
    process.exit(1);
  }
  const source = readFileSync(new URL("../desktop/src/update.rs", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  try {
    const expect = { current: programPublicKey(source), legacy: LEGACY_PUBLIC_KEY };
    writeFileSync(file, `${JSON.stringify(signManifest(manifest, { current, legacy }, new Date(), expect), null, 2)}\n`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  console.log(legacy ? "✓ 已簽章（新金鑰；另外用舊金鑰簽給還沒換金鑰的舊版本）" : "✓ 已簽章（新金鑰）");
}
