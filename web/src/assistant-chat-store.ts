/**
 * 助理的對話紀錄：每個專案留最近一次的對話，重開程式、切回這個專案時接著問。
 * 存在這台電腦的瀏覽器儲存空間（和草稿一樣），不會送到別的地方；按「新對話」就清掉。
 * 這裡只管存取與大小的上限；畫面在 app/assistant.ts。
 */
import type { AssistantMessage } from "./desktop.ts";
import type { TranscriptItem } from "./assistant-text.ts";
import * as storage from "./storage.ts";

export interface SavedChat {
  /** 接著問時送回去的對話（只有文字）。 */
  history: AssistantMessage[];
  /** 畫面上的一問一答。 */
  transcript: TranscriptItem[];
}

const KEY = "assistant-chats";
/** 最多記幾個專案、每個專案留幾組問答、全部加起來最多幾個字（太大就丟掉最舊的）。 */
export const CHAT_LIMITS = { projects: 20, items: 30, chars: 400_000 } as const;

type Store = Record<string, SavedChat & { at: number }>;

const norm = (root: string) => root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function read(): Store {
  try {
    const v: unknown = JSON.parse(storage.load(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): v is string => typeof v === "string";

/** 存進來的資料可能是舊版或壞掉的：只留格式對的部分。 */
function clean(chat: unknown): SavedChat | null {
  const c = chat as Partial<SavedChat> | null;
  if (!c || !Array.isArray(c.history) || !Array.isArray(c.transcript)) return null;
  const history = c.history.filter((m): m is AssistantMessage => !!m && (m.role === "user" || m.role === "assistant") && text(m.content)).map((m) => ({ role: m.role, content: m.content }));
  const transcript = c.transcript.filter((i): i is TranscriptItem => !!i && text(i.question) && text(i.answer)).map((i) => ({ question: i.question, answer: i.answer }));
  // 接著問的對話要從使用者開始、一問一答；對不上就不接（畫面上的紀錄照樣顯示）。
  const paired = history.length % 2 === 0 && history.every((m, i) => m.role === (i % 2 ? "assistant" : "user"));
  return transcript.length ? { history: paired ? history : [], transcript } : null;
}

const size = (c: SavedChat) => c.transcript.reduce((n, i) => n + i.question.length + i.answer.length, 0) + c.history.reduce((n, m) => n + m.content.length, 0);

/** 這個專案上次的對話；沒有就是 null。 */
export function loadChat(root: string): SavedChat | null {
  return clean(read()[norm(root)]);
}

/** 記下這個專案的對話；空的對話等於清掉。太多、太大時丟掉最久沒用的專案。 */
export function saveChat(root: string, chat: SavedChat, now = Date.now()): void {
  const store = read();
  const key = norm(root);
  if (!chat.transcript.length) delete store[key];
  else store[key] = { history: chat.history.map((m) => ({ role: m.role, content: m.content })), transcript: chat.transcript.slice(-CHAT_LIMITS.items), at: now };
  const order = Object.keys(store).sort((a, b) => (store[b].at ?? 0) - (store[a].at ?? 0));
  let total = 0;
  for (const [i, k] of order.entries()) {
    total += size(store[k]);
    // 目前這個專案（最新的）一定留著；其他的超過數量或大小就丟。
    if (i > 0 && (i >= CHAT_LIMITS.projects || total > CHAT_LIMITS.chars)) delete store[k];
  }
  if (!storage.save(KEY, JSON.stringify(store)) && Object.keys(store).length > 1) {
    // 存不下（空間滿了）：只留目前這個專案再試一次。
    storage.save(KEY, JSON.stringify(key in store ? { [key]: store[key] } : {}));
  }
}
