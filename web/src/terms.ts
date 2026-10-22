/**
 * 兩國用語與錯別字檢查：找出中國用語（建議台灣的說法）與台灣常見的錯別字。
 * 只比對詞語，不猜文意；同一個詞在台灣也有別的意思時標成「依文意」，不會在整份修正時自動換掉。
 */

export type TermKind = "cn" | "typo" | "punct";

export interface Term {
  /** 要找的詞。 */
  word: string;
  /** 建議的寫法（第一個是預設）。 */
  to: string[];
  kind: TermKind;
  /** 依文意判斷：在台灣也有其他意思，整份修正時不自動換。 */
  context: boolean;
  /** 說明（依文意的詞會寫什麼情況才要改）。 */
  note?: string;
  /** 出現在這些詞裡時不算（例如「數據機」）。 */
  except: string[];
}

/**
 * 每行一個詞：`中國用語=台灣用語/另一種說法`。
 * 開頭 `?` 表示依文意；`#` 後面是說明；`~` 後面是不算的詞（用逗號分隔）。
 */
const CN = `
視頻=影片
短視頻=短影音
默認=預設
鼠標=滑鼠
打印=列印
屏幕=螢幕
全屏=全螢幕
截屏=截圖/螢幕截圖
內存=記憶體
硬盤=硬碟
光盤=光碟
網盤=雲端硬碟
U盤=隨身碟
芯片=晶片
帶寬=頻寬
高清=高畫質
攝像頭=鏡頭/攝影機
筆記本電腦=筆記型電腦
台式機=桌上型電腦
操作系統=作業系統
軟件=軟體
硬件=硬體
網絡=網路
互聯網=網際網路
服務器=伺服器
服務端=伺服器端
客戶端=用戶端
數據庫=資料庫
源代碼=原始碼
?代碼=程式碼#指程式時（股票代碼、郵遞區號等不用改）
字符串=字串
字符=字元
變量=變數
數組=陣列
隊列=佇列
線程=執行緒
遞歸=遞迴
算法=演算法
回調=回呼
異步=非同步
調試=除錯
緩存=快取
模塊=模組
組件=元件
控件=控制項
插件=外掛/擴充功能
?接口=介面#指軟體介面時（零件的接口不用改）
兼容=相容
卸載=解除安裝
加載=載入
激活=啟用
內置=內建
文檔=文件
視圖=檢視
主頁=首頁
超鏈接=超連結
鏈接=連結
粘貼=貼上
彈窗=彈出視窗
博客=部落格
在線=線上~在線上
實時=即時
雲計算=雲端運算
人工智能=人工智慧
智能=智慧~智能障礙
移動端=行動裝置
賬號=帳號
賬戶=帳戶
短信=簡訊
?信號=訊號#指電子訊號時~信號彈,信號燈
反饋=回饋
?交互=互動#指人與軟體的互動時~交互作用
運營=營運
營銷=行銷
性價比=CP 值
點贊=按讚
外賣=外送
盒飯=便當
方便麵=泡麵
酸奶=優格
出租車=計程車
公交車=公車
打車=叫車
立馬=馬上
靠譜=可靠
?信息=資訊/訊息#指資料、消息時
?質量=品質#指好壞時（物理的質量不用改）~質量守恆,質量數
?數據=資料/數字#指資料時~數據機
?設置=設定#指軟體選項時（設立機構的「設置」不用改）
?支持=支援#指功能、技術支援時（贊成的「支持」不用改）
?程序=程式#指電腦程式時（流程、手續的「程序」不用改）~程序正義,法律程序,行政程序
?進程=處理程序/進度#指電腦程式或工作進度時
?運行=執行#指程式時（天體運行不用改）
?登錄=登入#指登入帳號時（登記的「登錄」不用改）
?用戶=使用者#指軟體使用者時（電信、水電的「用戶」不用改）
?對象=物件#指程式物件時（談話的對象不用改）
?函數=函式#指程式時（數學的「函數」不用改）
?循環=迴圈#指程式時
?指針=指標#指程式時
?擴展=擴充
?刷新=重新整理
?點擊=點選/按#指操作按鈕時（點擊率不用改）~點擊率
?菜單=選單#指軟體選單時（餐廳的菜單不用改）
?計算機=電腦#指電腦時（按數字的計算機不用改）
?渠道=管道/通路
?土豆=馬鈴薯#台灣的土豆是花生
?地鐵=捷運
?快遞=宅配/貨運
?自帶=內建
?貌似=似乎/好像
`;

/** 台灣常見的錯別字（只收不會誤判的詞）。 */
const TYPO = `
即然=既然
既使=即使
再接再勵=再接再厲
在接再厲=再接再厲
迫不急待=迫不及待
一股作氣=一鼓作氣
按步就班=按部就班
甘敗下風=甘拜下風
走頭無路=走投無路
默守成規=墨守成規
莫名奇妙=莫名其妙
談笑風聲=談笑風生
一愁莫展=一籌莫展
再所難免=在所難免
再所不惜=在所不惜
美崙美奐=美輪美奐
九宵雲外=九霄雲外
穿流不息=川流不息
惹事生非=惹是生非
鬼鬼崇崇=鬼鬼祟祟
一諾千斤=一諾千金
出奇不意=出其不意
記憶尤新=記憶猶新
破斧沉舟=破釜沉舟
必需要=必須要
反應問題=反映問題
部份=部分
?身份=身分#教育部的寫法是「身分」
`;

function parse(block: string, kind: TermKind): Term[] {
  return block
    .trim()
    .split("\n")
    .map((line) => {
      const context = line.startsWith("?");
      const [main, excepts = ""] = line.slice(context ? 1 : 0).split("~");
      const [pair, note] = main.split("#");
      const [word, to] = pair.split("=");
      return { word, to: to.split("/"), kind, context, note, except: excepts ? excepts.split(",") : [] };
    });
}

export const TERMS: readonly Term[] = [...parse(CN, "cn"), ...parse(TYPO, "typo")];

const byWord = new Map(TERMS.map((t) => [t.word, t]));
// 長的詞先比對（「字符串」優先於「字符」）。
const pattern = new RegExp(
  [...byWord.keys()]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "g",
);

export interface TermMatch {
  from: number;
  to: number;
  term: Term;
}

/**
 * 找出 `text` 中的中國用語與錯別字。`skip` 是不檢查的範圍（程式碼、網址等），`ignore` 是使用者選擇不再提示的詞。
 */
export function findTerms(
  text: string,
  skip: readonly [number, number][] = [],
  ignore: ReadonlySet<string> = new Set(),
): TermMatch[] {
  const out: TermMatch[] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const from = m.index;
    const to = from + m[0].length;
    const term = byWord.get(m[0])!;
    if (ignore.has(term.word)) continue;
    if (skip.some(([a, b]) => from < b && to > a)) continue;
    if (term.except.some((e) => covers(text, from, to, e))) continue;
    out.push({ from, to, term });
  }
  return out;
}

/** `text` 在 `from..to` 這段是不是剛好落在詞 `e` 裡。 */
function covers(text: string, from: number, to: number, e: string): boolean {
  const word = text.slice(from, to);
  for (let i = e.indexOf(word); i >= 0; i = e.indexOf(word, i + 1)) {
    if (text.slice(from - i, from - i + e.length) === e) return true;
  }
  return false;
}

/** 提示文字，例如「「視頻」是中國用語，台灣說「影片」」。 */
export function termMessage(t: Term): string {
  const to = t.to.map((w) => `「${w}」`).join("或");
  if (t.kind === "punct") return `${t.note}：改成${to}`;
  if (t.kind === "typo") return `「${t.word}」可能是錯字，應該是${to}${t.note ? `（${t.note}）` : ""}`;
  if (t.context) return `「${t.word}」${t.note ? `${t.note}，` : "在這裡如果是中國用語，"}台灣說${to}`;
  return `「${t.word}」是中國用語，台灣說${to}`;
}

/** 整份修正：只換不需要判斷文意的詞，回傳修改清單（由後往前套用不會影響位置）。 */
export function sureFixes(matches: readonly TermMatch[]): { from: number; to: number; insert: string }[] {
  return matches.filter((m) => !m.term.context).map((m) => ({ from: m.from, to: m.to, insert: m.term.to[0] }));
}
