/**
 * 測試用的 Outlook 郵件（.msg）：用 msgreader 附的 CFB 寫入工具（burn）組出最少的內容：
 * 主旨、寄件人、收件人與副本、HTML 內文（含一個 cid: 內嵌圖片）與一個附件。資料都是假的。
 */
import { burn } from "@kenjiuno/msgreader/lib/Burner.js";

const DIR = 1;
const DOC = 2;
const ROOT = 5;
const utf16 = (s) => Buffer.from(s, "utf16le");

/** `__properties_version1.0`：`header` 位元組的檔頭，後面每個屬性 16 位元組（tag、flags、值）。 */
function props(header, list) {
  const out = Buffer.alloc(header + list.length * 16);
  list.forEach(([tag, value], i) => {
    const at = header + i * 16;
    out.writeUInt32LE(tag >>> 0, at);
    out.writeUInt32LE(6, at + 4);
    if (typeof value === "number") out.writeUInt32LE(value, at + 8);
    else if (Buffer.isBuffer(value)) out.writeUInt32LE(value.length, at + 8);
  });
  return out;
}

export function mailFile({ png }) {
  const entries = [{ name: "Root Entry", type: ROOT, length: 0, children: [] }];
  const add = (parent, name, data) => {
    // 複製成獨立的陣列：Buffer 可能和其他資料共用同一塊記憶體，burn 會讀到別的內容。
    const bytes = data === undefined ? null : Uint8Array.from(data);
    const i = entries.push(bytes ? { name, type: DOC, length: bytes.length, binaryProvider: () => bytes } : { name, type: DIR, length: 0, children: [] }) - 1;
    entries[parent].children.push(i);
    return i;
  };
  const html = '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>大家好，<b>上線時程</b>如下：</p><img src="cid:chart@ado.test"><p><a href="https://ado.test/wiki">Wiki</a> <a href="javascript:alert(1)">危險</a></p></body></html>';
  add(0, "__substg1.0_0037001F", utf16("上線時程確認"));
  add(0, "__substg1.0_0C1A001F", utf16("王小明"));
  add(0, "__substg1.0_5D01001F", utf16("ming@ado.test"));
  add(0, "__substg1.0_1000001F", utf16("大家好，上線時程如下。"));
  add(0, "__substg1.0_10130102", Buffer.from(html, "utf8"));
  add(0, "__properties_version1.0", props(32, []));
  const recip = (n, name, email, type) => {
    const r = add(0, `__recip_version1.0_#0000000${n}`);
    add(r, "__substg1.0_3001001F", utf16(name));
    add(r, "__substg1.0_39FE001F", utf16(email));
    add(r, "__properties_version1.0", props(8, [[0x0c150003, type]]));
  };
  recip(0, "李大同", "datong@ado.test", 1);
  recip(1, "陳小華", "hua@ado.test", 2);
  const attach = (n, name, mime, data, cid) => {
    const a = add(0, `__attach_version1.0_#0000000${n}`);
    add(a, "__substg1.0_3707001F", utf16(name));
    add(a, "__substg1.0_370E001F", utf16(mime));
    if (cid) add(a, "__substg1.0_3712001F", utf16(cid));
    add(a, "__substg1.0_37010102", data);
    add(a, "__properties_version1.0", props(8, [[0x0e200003, data.length]]));
  };
  attach(0, "chart.png", "image/png", png, "chart@ado.test");
  attach(1, "規格書.pdf", "application/pdf", Buffer.from("%PDF-1.4 假的內容"));
  return Buffer.from(burn(entries)).toString("base64");
}
