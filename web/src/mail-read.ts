/**
 * Outlook 郵件（.msg）讀成 HTML，給分頁唯讀檢視（app/office-view.ts）：用 @kenjiuno/msgreader 解開微軟的複合檔格式，
 * 取出主旨、寄件人、收件人（收件人、副本）、日期、內文（HTML 或純文字）與附件清單。
 * 內文裡用 `cid:` 參照的內嵌圖片換成 data: 網址；輸出的 HTML 顯示前還要經過 office-html.ts 的白名單。
 */
import * as msgreader from "@kenjiuno/msgreader";
import { t } from "./i18n.ts";

export interface MailAttachment {
  name: string;
  size: number;
  /** 附件的內容（點開時才讀）。 */
  content(): Uint8Array;
}

export interface Mail {
  html: string;
  attachments: MailAttachment[];
}

/** 套件是 CommonJS（`exports.default = MsgReader`），打包後預設匯出可能多包一層。 */
type Reader = typeof msgreader.default;
const MsgReader: Reader = ((msgreader.default as unknown as { default?: Reader }).default ?? msgreader.default) as Reader;

const IMAGE = /^image\/(png|jpe?g|gif|webp|bmp)$/i;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** `王小明 <ming@ado.test>`；只有其中一個時顯示有的那個。 */
function person(name?: string, email?: string): string {
  if (name && email && name !== email) return `${name} <${email}>`;
  return name || email || "";
}

export function readMsg(data: ArrayBuffer): Mail {
  const reader = new MsgReader(data);
  const info = reader.getFileData();
  if (info.error) throw new Error(t("這不是有效的 Outlook 郵件（.msg）檔案"));
  const head = el("header");
  head.className = "office-mail-head";
  head.append(el("h2", info.subject || t("（沒有主旨）")));
  const fields = el("dl");
  const row = (label: string, value: string) => {
    if (!value) return;
    fields.append(el("dt", label), el("dd", value));
  };
  row(t("寄件人"), person(info.senderName, info.senderSmtpAddress || info.senderEmail));
  const recipients = info.recipients ?? [];
  const list = (type: "to" | "cc") =>
    recipients
      .filter((r) => (r.recipType ?? "to") === type)
      .map((r) => person(r.name, r.smtpAddress || r.email))
      .join(t("、"));
  row(t("收件人"), list("to"));
  row(t("副本"), list("cc"));
  const when = info.messageDeliveryTime || info.clientSubmitTime || info.creationTime;
  const date = when ? new Date(when) : null;
  row(t("日期"), date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : "");
  head.append(fields);

  // 附件：內嵌在內文裡的圖片（有 contentId 的）換掉 cid: 網址；內文裡有用到的不再列在附件裡。
  const attachments: (MailAttachment & { cid?: string })[] = [];
  const inline = new Map<string, string>();
  for (const a of info.attachments ?? []) {
    if (a.innerMsgContent) {
      attachments.push({ name: (a.name || a.subject || t("郵件")) + ".msg", size: a.contentLength ?? 0, content: () => reader.getAttachment(a).content });
      continue;
    }
    const name = a.fileName || a.fileNameShort || a.name || t("附件");
    const type = a.attachMimeTag ?? "";
    const cid = a.pidContentId?.replace(/^<|>$/g, "").toLowerCase();
    if (cid && IMAGE.test(type)) {
      try {
        const file = reader.getAttachment(a);
        inline.set(cid, `data:${type};base64,${bytesToBase64(file.content)}`);
      } catch {
        // 讀不到的內嵌圖片照樣列在附件裡。
      }
    }
    attachments.push({ name, size: a.contentLength ?? 0, cid, content: () => reader.getAttachment(a).content });
  }

  const body = el("div");
  body.className = "office-mail-body";
  const html = info.bodyHtml || (info.html ? new TextDecoder().decode(info.html) : "");
  const used = new Set<string>();
  if (html) {
    body.innerHTML = html.replace(/(src\s*=\s*["']?)cid:([^"'\s>]+)/gi, (all, pre: string, id: string) => {
      const url = inline.get(id.toLowerCase());
      if (url) used.add(id.toLowerCase());
      return url ? `${pre}${url}` : all;
    });
  } else {
    for (const para of (info.body ?? "").split(/\r?\n\r?\n/)) {
      const p = el("p");
      p.className = "office-mail-text";
      p.textContent = para;
      body.append(p);
    }
  }
  const out = el("div");
  out.append(head, body);
  return { html: out.innerHTML, attachments: attachments.filter((a) => !a.cid || !used.has(a.cid)).map(({ name, size, content }) => ({ name, size, content })) };
}
