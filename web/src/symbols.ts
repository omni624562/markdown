/**
 * 符號面板的資料：分類、名稱（台灣用語，英文介面顯示英文名稱）與搜尋用的別名。
 * 每一筆是 `[符號, 名稱, 別名]`；別名用空白分隔，可以是英文、中文或打字自動轉換的寫法（例如 `<=`）。
 * 搜尋會比對目前介面語言的名稱、別名與符號本身。
 */
import { t } from "./i18n.ts";

export interface SymbolEntry {
  char: string;
  name: string;
  /** 搜尋用：名稱、別名、符號本身，全部小寫。 */
  search: string;
}

export interface SymbolCategory {
  id: string;
  label: string;
  symbols: SymbolEntry[];
}

/** 一個符號：符號、名稱、搜尋用的別名（空白分隔；中文別名是搜尋資料，不翻譯）。 */
type Row = [char: string, name: string, aliases?: string];

const RAW: [string, string, Row[]][] = [
  [
    "math",
    t("數學"),
    [
      ["≤", t("小於等於"), "<= le"],
      ["≥", t("大於等於"), ">= ge"],
      ["≠", t("不等於"), "!= ne"],
      ["≈", t("約等於"), "~= approx"],
      ["±", t("正負"), "+- plusminus"],
      ["×", t("乘號"), "times"],
      ["÷", t("除號"), "divide"],
      ["∞", t("無限大"), "infinity"],
      ["√", t("根號"), "sqrt"],
      ["∑", t("總和"), "sum sigma"],
      ["∏", t("連乘"), "product"],
      ["∫", t("積分"), "integral"],
      ["∂", t("偏微分"), "partial"],
      ["∆", t("變化量"), "delta"],
      ["∇", t("梯度"), "nabla"],
      ["π", t("圓周率"), "pi"],
      ["∈", t("屬於"), "in"],
      ["∉", t("不屬於"), "notin"],
      ["⊂", t("真子集合"), "subset"],
      ["⊆", t("子集合"), "subseteq"],
      ["∩", t("交集"), "intersection"],
      ["∪", t("聯集"), "union"],
      ["∅", t("空集合"), "empty"],
      ["∀", t("對所有"), "forall"],
      ["∃", t("存在"), "exists"],
      ["¬", t("非"), "not"],
      ["∧", t("且"), "and"],
      ["∨", t("或"), "or"],
      ["∴", t("所以"), "therefore"],
      ["∵", t("因為"), "because"],
      ["∠", t("角"), "angle"],
      ["⊥", t("垂直"), "perpendicular"],
      ["∥", t("平行"), "parallel"],
      ["∝", t("正比"), "proportional"],
      ["≡", t("恆等"), "equiv"],
      ["≪", t("遠小於"), "much less"],
      ["≫", t("遠大於"), "much greater"],
      ["‰", t("千分比"), "permille"],
      ["½", t("二分之一"), "half"],
      ["⅓", t("三分之一"), "third"],
      ["¼", t("四分之一"), "quarter"],
      ["¾", t("四分之三")],
      ["²", t("平方"), "上標2 squared"], // i18n-ignore
      ["³", t("立方"), "上標3 cubed"], // i18n-ignore
      ["¹", t("上標{n}", { n: "1" })],
      ["ⁿ", t("上標{n}", { n: "n" })],
      ["₀", t("下標{n}", { n: "0" })],
      ["₁", t("下標{n}", { n: "1" })],
      ["₂", t("下標{n}", { n: "2" })],
      ["°", t("度"), "degree"],
      ["′", t("分（角度）"), "prime"],
      ["″", t("秒（角度）"), "double prime"],
    ],
  ],
  [
    "arrow",
    t("箭頭"),
    [
      ["→", t("右箭頭"), "-> right arrow"],
      ["←", t("左箭頭"), "<- left arrow"],
      ["↑", t("上箭頭"), "up arrow"],
      ["↓", t("下箭頭"), "down arrow"],
      ["↔", t("左右箭頭"), "<-> both"],
      ["↕", t("上下箭頭")],
      ["⇒", t("推得"), "=> implies"],
      ["⇐", t("左雙箭頭"), "<="],
      ["⇔", t("等價"), "<=> iff"],
      ["⇑", t("上雙箭頭")],
      ["⇓", t("下雙箭頭")],
      ["↗", t("右上箭頭"), "上升 up"], // i18n-ignore
      ["↘", t("右下箭頭"), "下降 down"], // i18n-ignore
      ["↙", t("左下箭頭")],
      ["↖", t("左上箭頭")],
      ["➜", t("粗右箭頭")],
      ["↩", t("返回"), "return"],
      ["↪", t("轉向")],
      ["▶", t("右三角形"), "play"],
      ["◀", t("左三角形")],
      ["▲", t("上三角形"), "增加 up increase"], // i18n-ignore
      ["▼", t("下三角形"), "減少 down decrease"], // i18n-ignore
    ],
  ],
  [
    "check",
    t("勾選與圖形"),
    [
      ["✓", t("打勾"), "check ok"],
      ["✔", t("粗打勾"), "check"],
      ["✗", t("打叉"), "cross x"],
      ["✘", t("粗打叉"), "cross"],
      ["☐", t("核取方塊"), "checkbox 未完成 todo"], // i18n-ignore
      ["☑", t("已勾選方塊"), "checked 完成 done"], // i18n-ignore
      ["☒", t("已打叉方塊")],
      ["●", t("實心圓"), "bullet"],
      ["○", t("空心圓"), "circle"],
      ["◎", t("雙圓")],
      ["◆", t("實心菱形"), "diamond"],
      ["◇", t("空心菱形")],
      ["■", t("實心方塊"), "square"],
      ["□", t("空心方塊")],
      ["▪", t("小方塊")],
      ["★", t("實心星號"), "star"],
      ["☆", t("空心星號")],
      ["※", t("參考符號"), "註記 note note"], // i18n-ignore
      ["⚠", t("警告"), "warning"],
      ["♥", t("愛心"), "heart"],
      ["•", t("項目符號"), "bullet"],
      ["◦", t("空心項目符號")],
      ["‣", t("三角項目符號")],
    ],
  ],
  [
    "punct",
    t("標點"),
    [
      ["、", t("頓號")], // i18n-ignore
      ["。", t("句號")], // i18n-ignore
      ["，", t("逗號")], // i18n-ignore
      ["；", t("分號")], // i18n-ignore
      ["：", t("冒號")], // i18n-ignore
      ["？", t("問號")], // i18n-ignore
      ["！", t("驚嘆號")], // i18n-ignore
      ["「", t("上引號"), "開引號"], // i18n-ignore
      ["」", t("下引號"), "關引號"], // i18n-ignore
      ["『", t("雙上引號")], // i18n-ignore
      ["』", t("雙下引號")], // i18n-ignore
      ["（", t("全形左括號")], // i18n-ignore
      ["）", t("全形右括號")], // i18n-ignore
      ["《", t("書名號"), "左 left"], // i18n-ignore
      ["》", t("書名號"), "右 right"], // i18n-ignore
      ["〈", t("篇名號"), "左 left"], // i18n-ignore
      ["〉", t("篇名號"), "右 right"], // i18n-ignore
      ["【", t("實心方括號"), "左 left"], // i18n-ignore
      ["】", t("實心方括號"), "右 right"], // i18n-ignore
      ["〔", t("龜甲括號"), "左 left"], // i18n-ignore
      ["〕", t("龜甲括號"), "右 right"], // i18n-ignore
      ["……", t("刪節號"), "ellipsis"],
      ["——", t("破折號"), "dash"],
      ["～", t("全形波浪號"), "tilde 至 to"], // i18n-ignore
      ["‧", t("間隔號"), "音界號"], // i18n-ignore
      ["／", t("全形斜線"), "slash"], // i18n-ignore
      ["＆", t("全形＆"), "全形 and ampersand"], // i18n-ignore
      ["＃", t("全形井號")], // i18n-ignore
      ["＠", t("全形小老鼠"), "at"], // i18n-ignore
      ["％", t("全形百分比")], // i18n-ignore
      ["＊", t("全形星號")], // i18n-ignore
      ["“", t("英文左雙引號"), "quote"],
      ["”", t("英文右雙引號"), "quote"],
      ["‘", t("英文左單引號")],
      ["’", t("英文右單引號"), "apostrophe"],
      ["–", t("短破折號"), "en dash"],
      ["—", t("長破折號"), "em dash"],
      ["…", t("英文刪節號"), "..."],
    ],
  ],
  [
    "unit",
    t("單位與貨幣"),
    [
      ["℃", t("攝氏"), "celsius"],
      ["℉", t("華氏"), "fahrenheit"],
      ["µ", t("微"), "micro"],
      ["Ω", t("歐姆"), "ohm capital uppercase"],
      ["㎡", t("平方公尺"), "m2"],
      ["㎥", t("立方公尺"), "m3"],
      ["㎏", t("公斤"), "kg"],
      ["㎎", t("毫克"), "mg"],
      ["㎝", t("公分"), "cm"],
      ["㎜", t("公釐"), "mm"],
      ["㎞", t("公里"), "km"],
      ["㏄", t("西西"), "cc"],
      ["㎖", t("毫升"), "ml"],
      ["NT$", t("新臺幣"), "台幣 twd ntd"], // i18n-ignore
      ["$", t("美元"), "dollar"],
      ["€", t("歐元"), "euro"],
      ["£", t("英鎊"), "pound"],
      ["¥", t("日圓"), "人民幣 yen cny rmb yuan"], // i18n-ignore
      ["₩", t("韓元"), "won"],
      ["¢", t("分（貨幣）"), "cent"],
      ["©", t("版權"), "copyright (c)"],
      ["®", t("註冊商標"), "registered (r)"],
      ["™", t("商標"), "trademark (tm)"],
      ["§", t("條（法規）"), "section"],
      ["¶", t("段落"), "paragraph"],
      ["№", t("編號符號"), "編號 number"], // i18n-ignore
      ["†", t("劍號"), "dagger"],
    ],
  ],
  [
    "greek",
    t("希臘字母"),
    [
      ["α", "alpha"],
      ["β", "beta"],
      ["γ", "gamma"],
      ["δ", "delta"],
      ["ε", "epsilon"],
      ["ζ", "zeta"],
      ["η", "eta"],
      ["θ", "theta"],
      ["λ", "lambda"],
      ["μ", "mu"],
      ["ξ", "xi"],
      ["π", "pi"],
      ["ρ", "rho"],
      ["σ", "sigma"],
      ["τ", "tau"],
      ["φ", "phi"],
      ["χ", "chi"],
      ["ψ", "psi"],
      ["ω", "omega"],
      ["Γ", "Gamma", "大寫 capital uppercase"], // i18n-ignore
      ["Δ", "Delta", "大寫 capital uppercase"], // i18n-ignore
      ["Θ", "Theta", "大寫 capital uppercase"], // i18n-ignore
      ["Λ", "Lambda", "大寫 capital uppercase"], // i18n-ignore
      ["Π", "Pi", "大寫 capital uppercase"], // i18n-ignore
      ["Σ", "Sigma", "大寫 capital uppercase"], // i18n-ignore
      ["Φ", "Phi", "大寫 capital uppercase"], // i18n-ignore
      ["Ψ", "Psi", "大寫 capital uppercase"], // i18n-ignore
      ["Ω", "Omega", "大寫 capital uppercase"], // i18n-ignore
    ],
  ],
  [
    "number",
    t("編號"),
    [
      ["①", t("圓圈{n}", { n: "1" })],
      ["②", t("圓圈{n}", { n: "2" })],
      ["③", t("圓圈{n}", { n: "3" })],
      ["④", t("圓圈{n}", { n: "4" })],
      ["⑤", t("圓圈{n}", { n: "5" })],
      ["⑥", t("圓圈{n}", { n: "6" })],
      ["⑦", t("圓圈{n}", { n: "7" })],
      ["⑧", t("圓圈{n}", { n: "8" })],
      ["⑨", t("圓圈{n}", { n: "9" })],
      ["⑩", t("圓圈{n}", { n: "10" })],
      ["⑪", t("圓圈{n}", { n: "11" })],
      ["⑫", t("圓圈{n}", { n: "12" })],
      ["Ⅰ", t("羅馬數字{n}", { n: "1" })],
      ["Ⅱ", t("羅馬數字{n}", { n: "2" })],
      ["Ⅲ", t("羅馬數字{n}", { n: "3" })],
      ["Ⅳ", t("羅馬數字{n}", { n: "4" })],
      ["Ⅴ", t("羅馬數字{n}", { n: "5" })],
      ["Ⅵ", t("羅馬數字{n}", { n: "6" })],
      ["Ⅶ", t("羅馬數字{n}", { n: "7" })],
      ["Ⅷ", t("羅馬數字{n}", { n: "8" })],
      ["Ⅸ", t("羅馬數字{n}", { n: "9" })],
      ["Ⅹ", t("羅馬數字{n}", { n: "10" })],
      ["㈠", t("括號一")],
      ["㈡", t("括號二")],
      ["㈢", t("括號三")],
      ["㈣", t("括號四")],
      ["㈤", t("括號五")],
    ],
  ],
];

export const SYMBOL_CATEGORIES: SymbolCategory[] = RAW.map(([id, label, rows]) => ({
  id,
  label,
  symbols: rows.map(([char, name, aliases = ""]) => ({ char, name, search: [char, name, aliases].join(" ").toLowerCase() })),
}));

const ALL = SYMBOL_CATEGORIES.flatMap((c) => c.symbols);

/** 依關鍵字搜尋所有分類（名稱、別名或符號本身），名稱開頭相符的排前面，不重複。 */
export function searchSymbols(query: string): SymbolEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set<string>();
  const hits = ALL.filter((s) => s.search.includes(q) && !seen.has(s.char) && seen.add(s.char));
  const rank = (s: SymbolEntry) => (s.char === q ? 0 : s.name.toLowerCase().startsWith(q) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b));
}

/** 符號的名稱（最近使用的符號顯示提示用）。 */
export function symbolName(char: string): string {
  return ALL.find((s) => s.char === char)?.name ?? char;
}
