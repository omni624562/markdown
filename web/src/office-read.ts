/**
 * Excel（.xlsx）與 PowerPoint（.pptx）讀成 HTML，給分頁唯讀檢視（app/office-view.ts）。
 * 兩種都是 ZIP 裡放 XML：用 JSZip 解開、用瀏覽器的 DOMParser 讀 XML。只取看得到的內容：
 * - Excel：每個工作表的儲存格值（文字、數字、日期、百分比、TRUE/FALSE），合併儲存格；不含公式、圖表、格式顏色。
 * - PowerPoint：每張投影片的標題、文字（照段落與縮排）、表格與圖片（PNG、JPEG、GIF）；不是原本的版面。
 * 輸出的 HTML 顯示前還要經過 office-html.ts 的白名單。
 */
import JSZip from "jszip";
import { t } from "./i18n.ts";
import { zipUncompressedSize } from "./zip-size.ts";

/** 解壓縮後超過這個大小就不讀（可能是損毀或惡意的檔案）。 */
const MAX_UNCOMPRESSED = 500 * 1024 * 1024;
/** 每個工作表最多顯示幾列、幾欄（再多畫面也看不完，還會很慢）。 */
export const MAX_ROWS = 2000;
export const MAX_COLS = 200;

async function openZip(data: ArrayBuffer, what: string): Promise<JSZip> {
  const size = zipUncompressedSize(data);
  if (size === null) throw new Error(t("這不是有效的 {what} 檔案", { what }));
  if (size > MAX_UNCOMPRESSED) throw new Error(t("這個檔案解壓縮後太大，可能是損毀或惡意的檔案"));
  return JSZip.loadAsync(data);
}

async function xml(zip: JSZip, path: string): Promise<Document | null> {
  const file = zip.file(path);
  if (!file) return null;
  const doc = new DOMParser().parseFromString(await file.async("string"), "application/xml");
  return doc.getElementsByTagName("parsererror").length ? null : doc;
}

/** 名稱空間不管，只看本地名稱。 */
function all(node: Element | Document, local: string): Element[] {
  return [...node.getElementsByTagNameNS("*", local)];
}
function first(node: Element | Document, local: string): Element | null {
  return node.getElementsByTagNameNS("*", local)[0] ?? null;
}
function kids(node: Element, local: string): Element[] {
  return [...node.children].filter((c) => c.localName === local);
}

/** 關聯檔（`_rels/x.xml.rels`）：id → 目標路徑（相對於 `base` 資料夾，整理成 ZIP 裡的完整路徑）。 */
async function rels(zip: JSZip, owner: string): Promise<Map<string, string>> {
  const dir = owner.slice(0, owner.lastIndexOf("/") + 1);
  const doc = await xml(zip, `${dir}_rels/${owner.slice(dir.length)}.rels`);
  const map = new Map<string, string>();
  if (!doc) return map;
  for (const r of all(doc, "Relationship")) {
    const target = r.getAttribute("Target") ?? "";
    map.set(r.getAttribute("Id") ?? "", target.startsWith("/") ? target.slice(1) : normalize(dir + target));
  }
  return map;
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------- Excel ----------

export interface Sheet {
  name: string;
  rows: string[][];
  /** 合併儲存格：左上角的位置與跨幾列、幾欄。 */
  merges: { row: number; col: number; rows: number; cols: number }[];
  /** 超過上限沒有顯示的部分。 */
  truncated: boolean;
}

/** `B12` → 欄 1、列 11（從 0 開始）。 */
export function cellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const c of m[1]) col = col * 26 + (c.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

/** 內建的日期格式（numFmtId）。 */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const PERCENT_FORMATS = new Set([9, 10]);

/** 格式代碼是日期或時間嗎（去掉引號、方括號、跳脫字元後還有 y、m、d、h、s）。 */
export function isDateFormat(code: string): boolean {
  const plain = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  return /[ymdhs]/i.test(plain) && !/^[#0.,% ]*$/.test(plain);
}

/** Excel 的日期序號（1900 年制）→ `2026/07/21` 或 `2026/07/21 14:30`。 */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  const secs = Math.round((serial % 1) * 86400);
  if (!secs) return date;
  return `${serial >= 1 ? `${date} ` : ""}${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}`;
}

/** 數字照原本的精確度顯示（去掉 0.1+0.2 這類浮點數尾巴）。 */
export function plainNumber(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v;
}

export async function readXlsx(data: ArrayBuffer): Promise<Sheet[]> {
  const zip = await openZip(data, "Excel");
  const book = await xml(zip, "xl/workbook.xml");
  if (!book) throw new Error(t("這不是有效的 {what} 檔案", { what: "Excel" }));
  const bookRels = await rels(zip, "xl/workbook.xml");
  // 共用字串。
  const strings: string[] = [];
  const sst = await xml(zip, "xl/sharedStrings.xml");
  if (sst) for (const si of all(sst, "si")) strings.push(all(si, "t").map((x) => x.textContent ?? "").join(""));
  // 儲存格格式：第幾個格式是日期或百分比。
  const kinds: ("date" | "percent" | "")[] = [];
  const styles = await xml(zip, "xl/styles.xml");
  if (styles) {
    const custom = new Map(all(styles, "numFmt").map((f) => [Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") ?? ""]));
    const xfs = first(styles, "cellXfs");
    for (const xf of xfs ? kids(xfs, "xf") : []) {
      const id = Number(xf.getAttribute("numFmtId") ?? 0);
      const code = custom.get(id);
      kinds.push(DATE_FORMATS.has(id) || (code !== undefined && isDateFormat(code)) ? "date" : PERCENT_FORMATS.has(id) || code?.includes("%") ? "percent" : "");
    }
  }
  const sheets: Sheet[] = [];
  for (const s of all(book, "sheet")) {
    if (s.getAttribute("state") === "hidden" || s.getAttribute("state") === "veryHidden") continue;
    const id = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? s.getAttribute("r:id") ?? "";
    const path = bookRels.get(id);
    const doc = path ? await xml(zip, path) : null;
    const sheet: Sheet = { name: s.getAttribute("name") ?? "", rows: [], merges: [], truncated: false };
    if (doc) {
      for (const row of all(doc, "row")) {
        for (const c of kids(row, "c")) {
          const at = cellRef(c.getAttribute("r") ?? "");
          if (!at) continue;
          if (at.row >= MAX_ROWS || at.col >= MAX_COLS) {
            sheet.truncated = true;
            continue;
          }
          const type = c.getAttribute("t");
          const v = kids(c, "v")[0]?.textContent ?? "";
          let text: string;
          if (type === "s") text = strings[Number(v)] ?? "";
          else if (type === "inlineStr") text = all(c, "t").map((x) => x.textContent ?? "").join("");
          else if (type === "b") text = v === "1" ? "TRUE" : "FALSE";
          else if (type === "str" || type === "e") text = v;
          else if (v === "") text = "";
          else {
            const kind = kinds[Number(c.getAttribute("s") ?? 0)];
            text = kind === "date" ? excelDate(Number(v)) : kind === "percent" ? `${plainNumber(String(Number(v) * 100))}%` : plainNumber(v);
          }
          while (sheet.rows.length <= at.row) sheet.rows.push([]);
          sheet.rows[at.row][at.col] = text;
        }
      }
      for (const m of all(doc, "mergeCell")) {
        const [a, b] = (m.getAttribute("ref") ?? "").split(":").map(cellRef);
        if (a && b && a.row < MAX_ROWS && a.col < MAX_COLS) sheet.merges.push({ row: a.row, col: a.col, rows: b.row - a.row + 1, cols: b.col - a.col + 1 });
      }
    }
    sheets.push(sheet);
  }
  return sheets;
}

/** 一個工作表畫成表格（去掉最後面整欄空白的欄）。 */
export function sheetTable(sheet: Sheet): HTMLTableElement {
  const table = el("table");
  const width = Math.max(0, ...sheet.rows.map((r) => r.length));
  const covered = new Set<string>();
  const spans = new Map<string, { rows: number; cols: number }>();
  for (const m of sheet.merges) {
    spans.set(`${m.row},${m.col}`, m);
    for (let r = m.row; r < m.row + m.rows; r++) for (let c = m.col; c < m.col + m.cols; c++) if (r !== m.row || c !== m.col) covered.add(`${r},${c}`);
  }
  const body = el("tbody");
  sheet.rows.forEach((row, r) => {
    const tr = el("tr");
    for (let c = 0; c < width; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const td = el("td", row[c] ?? "");
      const span = spans.get(`${r},${c}`);
      if (span) {
        if (span.rows > 1) td.setAttribute("rowspan", String(span.rows));
        if (span.cols > 1) td.setAttribute("colspan", String(span.cols));
      }
      tr.append(td);
    }
    body.append(tr);
  });
  table.append(body);
  return table;
}

// ---------- PowerPoint ----------

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" };

export async function readPptx(data: ArrayBuffer): Promise<HTMLElement[]> {
  const zip = await openZip(data, "PowerPoint");
  const pres = await xml(zip, "ppt/presentation.xml");
  if (!pres) throw new Error(t("這不是有效的 {what} 檔案", { what: "PowerPoint" }));
  const presRels = await rels(zip, "ppt/presentation.xml");
  const slides: HTMLElement[] = [];
  let n = 0;
  for (const id of all(pres, "sldId")) {
    const rid = id.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? id.getAttribute("r:id") ?? "";
    const path = presRels.get(rid);
    const doc = path ? await xml(zip, path) : null;
    if (!path || !doc) continue;
    n++;
    const slideRels = await rels(zip, path);
    const section = el("section");
    section.className = "office-slide";
    section.append(el("small", t("第 {n} 張", { n })));
    const tree = first(doc, "spTree");
    if (tree) await shapes(tree, section, zip, slideRels);
    slides.push(section);
  }
  return slides;
}

/** 依投影片上的順序取出文字框、表格、圖片（群組裡的也一樣）。 */
async function shapes(tree: Element, out: HTMLElement, zip: JSZip, slideRels: Map<string, string>): Promise<void> {
  for (const node of [...tree.children]) {
    const name = node.localName;
    if (name === "grpSp") await shapes(node, out, zip, slideRels);
    else if (name === "sp") textShape(node, out);
    else if (name === "graphicFrame") {
      const tbl = first(node, "tbl");
      if (tbl) out.append(slideTable(tbl));
    } else if (name === "pic") {
      const blip = first(node, "blip");
      const rid = blip?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ?? blip?.getAttribute("r:embed");
      const target = rid ? slideRels.get(rid) : undefined;
      const ext = target?.split(".").pop()?.toLowerCase() ?? "";
      const file = target && IMAGE_TYPES[ext] ? zip.file(target) : null;
      if (file) {
        const img = el("img");
        img.src = `data:${IMAGE_TYPES[ext]};base64,${await file.async("base64")}`;
        img.alt = first(node, "cNvPr")?.getAttribute("descr") ?? "";
        out.append(img);
      }
    }
  }
}

function paragraphText(p: Element): string {
  return [...p.children]
    .map((c) => (c.localName === "r" || c.localName === "fld" ? (first(c, "t")?.textContent ?? "") : c.localName === "br" ? "\n" : ""))
    .join("");
}

function textShape(sp: Element, out: HTMLElement): void {
  const body = first(sp, "txBody");
  if (!body) return;
  const ph = first(sp, "ph")?.getAttribute("type") ?? "";
  const paras = kids(body, "p")
    .map((p) => ({ text: paragraphText(p), level: Number(first(p, "pPr")?.getAttribute("lvl") ?? 0) }))
    .filter((p) => p.text.trim());
  if (!paras.length) return;
  if (ph === "title" || ph === "ctrTitle") {
    out.append(el("h2", paras.map((p) => p.text).join(" ")));
    return;
  }
  if (ph === "subTitle") {
    for (const p of paras) out.append(el("p", p.text));
    return;
  }
  const list = el("ul");
  for (const p of paras) {
    const li = el("li", p.text);
    if (p.level) li.className = `office-level-${Math.min(p.level, 4)}`;
    list.append(li);
  }
  out.append(paras.length === 1 ? el("p", paras[0].text) : list);
}

function slideTable(tbl: Element): HTMLTableElement {
  const table = el("table");
  const body = el("tbody");
  for (const tr of kids(tbl, "tr")) {
    const row = el("tr");
    for (const tc of kids(tr, "tc")) {
      if (tc.getAttribute("hMerge") === "1" || tc.getAttribute("vMerge") === "1") continue;
      const td = el("td", all(tc, "p").map(paragraphText).join("\n"));
      const cols = Number(tc.getAttribute("gridSpan") ?? 1);
      const rows = Number(tc.getAttribute("rowSpan") ?? 1);
      if (cols > 1) td.setAttribute("colspan", String(cols));
      if (rows > 1) td.setAttribute("rowspan", String(rows));
      row.append(td);
    }
    body.append(row);
  }
  table.append(body);
  return table;
}
