/**
 * 指令中心：工具列按鈕、指令面板與快速鍵都從這裡取得同一份指令清單，
 * 確保三個入口的名稱、快速鍵與可用狀態一致。
 */

export interface Command {
  id: string;
  title: string;
  group: string;
  /** lucide 圖示名稱（例如 "bold"）。 */
  icon?: string;
  /** 快速鍵，例如 `Mod-Shift-p`；`Mod` 在 macOS 是 ⌘，其他平台是 Ctrl。 */
  keys?: string;
  /** 只顯示、不綁定的快速鍵（例如 Ctrl+C 由瀏覽器原生處理）。 */
  shownKeys?: string;
  /** 回傳 false 時不顯示於指令面板、快速鍵也不觸發。 */
  when?: () => boolean;
  run(): void | Promise<void>;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 用 `-` 分隔的快速鍵寫法裡，`=` 和 `-` 鍵改用名稱表示。 */
const NAMED_KEYS: Record<string, { label: string; codes: string[] }> = {
  Equal: { label: "=", codes: ["Equal", "NumpadAdd"] },
  Minus: { label: "-", codes: ["Minus", "NumpadSubtract"] },
  Space: { label: "Space", codes: ["Space"] },
};

/** 把 `Mod-Shift-p` 轉成 `⌘⇧P` 或 `Ctrl+Shift+P`。 */
export function formatKeys(keys: string, mac = isMac): string {
  const parts = keys.split("-");
  const key = parts.pop()!;
  const label = NAMED_KEYS[key]?.label ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) {
    const sym: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Shift: "⇧", Alt: "⌥" };
    return parts.map((p) => sym[p] ?? p).join("") + label;
  }
  return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), label].join("+");
}

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * 判斷鍵盤事件是否符合快速鍵。字母與數字比對實體按鍵（`event.code`），
 * 所以 macOS 按住 Option 或使用不同鍵盤配置時依然有效。
 */
export function matchKeys(keys: string, e: KeyLike, mac = isMac): boolean {
  const parts = keys.split("-");
  const key = parts.pop()!;
  const want = { ctrl: false, meta: false, shift: false, alt: false };
  for (const p of parts) {
    if (p === "Mod") want[mac ? "meta" : "ctrl"] = true;
    else if (p === "Ctrl") want.ctrl = true;
    else if (p === "Shift") want.shift = true;
    else if (p === "Alt") want.alt = true;
  }
  if (e.ctrlKey !== want.ctrl || e.metaKey !== want.meta || e.shiftKey !== want.shift || e.altKey !== want.alt) {
    return false;
  }
  if (NAMED_KEYS[key]) return NAMED_KEYS[key].codes.includes(e.code);
  if (/^[a-z]$/i.test(key)) return e.code === `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return e.code === `Digit${key}`;
  return e.key === key;
}

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"] as const;

/**
 * 快速鍵的標準寫法（修飾鍵固定順序、字母小寫），用來比較兩組快速鍵是不是同一組。
 * Windows／Linux 的 `Ctrl` 就是 `Mod`。
 */
export function normalizeKeys(keys: string, mac = isMac): string {
  const parts = keys.split("-");
  const raw = parts.pop()!;
  const key = /^[A-Z]$/.test(raw) ? raw.toLowerCase() : raw;
  const mods = new Set(parts.map((p) => (p === "Ctrl" && !mac ? "Mod" : p)));
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("-");
}

/** 只按了修飾鍵或輸入法按鍵：錄製時繼續等下一個鍵。 */
const NOT_A_KEY = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "CapsLock", "NumLock", "Dead", "Process", "Unidentified"]);

/**
 * 錄製快速鍵：把按下的鍵轉成 `Mod-Shift-p` 的寫法。字母與數字看實體按鍵，跟 `matchKeys` 一致。
 * 只按了修飾鍵、Windows 鍵，或是輸入法組字中時回傳 null。
 */
export function keysFromEvent(e: KeyLike & { isComposing?: boolean }, mac = isMac): string | null {
  if (e.isComposing || NOT_A_KEY.has(e.key)) return null;
  if (!mac && e.metaKey) return null;
  let key: string;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit(\d)$/.exec(e.code);
  const named = Object.entries(NAMED_KEYS).find(([, v]) => v.codes.includes(e.code));
  if (letter) key = letter[1].toLowerCase();
  else if (digit) key = digit[1];
  else if (named) key = named[0];
  else if (e.key && !/\s/.test(e.key) && e.key !== "-") key = e.key;
  else return null;
  const mods = [
    (mac ? e.metaKey : e.ctrlKey) && "Mod",
    mac && e.ctrlKey && "Ctrl",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
  ].filter(Boolean);
  return [...mods, key].join("-");
}

/** 不能拿來當快速鍵的組合：複製、貼上、復原、全選等編輯區最基本的按鍵。 */
const RESERVED = ["Mod-c", "Mod-v", "Mod-x", "Mod-z", "Mod-y", "Mod-Shift-z", "Mod-a"];

/**
 * 這組快速鍵能不能用：`modifier` 是沒有搭配 Ctrl／⌘／Alt（會吃掉打字，F1～F24 例外）；
 * `reserved` 是編輯區最基本的按鍵。可以用時回傳 null。
 */
export function keysProblem(keys: string, mac = isMac): "modifier" | "reserved" | null {
  const norm = normalizeKeys(keys, mac);
  if (RESERVED.includes(norm)) return "reserved";
  const parts = norm.split("-");
  const key = parts.pop()!;
  if (!parts.some((p) => p !== "Shift") && !/^F([1-9]|1\d|2[0-4])$/.test(key)) return "modifier";
  return null;
}

/** 設定檔裡的快速鍵寫法是否正確（`Mod-Shift-p`、`F5`、`Alt-PageDown`）。 */
export function validKeys(keys: string): boolean {
  const parts = keys.split("-");
  const key = parts.pop()!;
  if (!/^(?:[a-z0-9]|F(?:[1-9]|1\d|2[0-4])|[A-Z][A-Za-z]{1,15}|[^\sA-Za-z0-9-])$/u.test(key)) return false;
  return parts.every((p, i) => (MODIFIERS as readonly string[]).includes(p) && parts.indexOf(p) === i);
}

/**
 * 把指令 `id` 改成新的快速鍵（null 是拿掉）之後的自訂設定：跟內建的一樣就不記；
 * `unbind` 列的指令（原本用同一組快速鍵的）改成沒有快速鍵。
 */
export function withBinding(
  bindings: Readonly<Record<string, string>>,
  id: string,
  keys: string | null,
  defaultKeys: (id: string) => string | undefined,
  unbind: readonly string[] = [],
  mac = isMac,
): Record<string, string> {
  const next = { ...bindings };
  const set = (cmd: string, k: string | null) => {
    const def = defaultKeys(cmd);
    const same = k ? def !== undefined && normalizeKeys(def, mac) === normalizeKeys(k, mac) : def === undefined;
    if (same) delete next[cmd];
    else next[cmd] = k ?? "";
  };
  for (const other of unbind) if (other !== id) set(other, null);
  set(id, keys);
  return next;
}

export class Commands {
  #list: Command[] = [];
  /** 每個指令內建的快速鍵（自訂之前的）。 */
  #defaults = new Map<string, Pick<Command, "keys" | "shownKeys">>();
  #bindings: Readonly<Record<string, string>> = {};

  register(...cmds: Command[]): void {
    for (const c of cmds) {
      if (!this.#defaults.has(c.id)) this.#defaults.set(c.id, { keys: c.keys, shownKeys: c.shownKeys });
      this.#apply(c);
    }
    this.#list.push(...cmds);
  }

  /** 自訂過的指令用自訂的快速鍵，原本只顯示的（例如編輯區處理的 Ctrl+Shift+V）就不再顯示。 */
  #apply(c: Command): void {
    const def = this.#defaults.get(c.id);
    const custom = Object.hasOwn(this.#bindings, c.id);
    c.keys = custom ? this.#bindings[c.id] || undefined : def?.keys;
    c.shownKeys = custom ? undefined : def?.shownKeys;
  }

  /** 套用自訂的快速鍵：指令 id → 快速鍵；空字串是拿掉這個指令的快速鍵。沒列到的用內建的。 */
  setBindings(map: Readonly<Record<string, string>>): void {
    this.#bindings = map;
    for (const c of this.#list) this.#apply(c);
  }

  /** 指令內建的快速鍵（包括只顯示、由編輯區或瀏覽器處理的）。 */
  defaultKeys(id: string): string | undefined {
    const def = this.#defaults.get(id);
    return def?.keys ?? def?.shownKeys;
  }

  /** 所有指令（不論目前能不能用）。 */
  all(): readonly Command[] {
    return this.#list;
  }

  /** 已經使用這組快速鍵的其他指令（不論目前能不能用；包括只顯示的快速鍵）。同一個 id 只列一次。 */
  usedBy(keys: string, except?: string): Command[] {
    const want = normalizeKeys(keys);
    const seen = new Set<string>();
    return this.#list.filter((c) => {
      const k = c.keys ?? c.shownKeys;
      if (c.id === except || seen.has(c.id) || !k || normalizeKeys(k) !== want) return false;
      seen.add(c.id);
      return true;
    });
  }

  get(id: string): Command | undefined {
    return this.#list.find((c) => c.id === id);
  }

  /** 指令的名稱：提示文字提到指令時用這個，指令改名時提示跟著變。沒有這個指令時是 id。 */
  title(id: string): string {
    return this.get(id)?.title ?? id;
  }

  available(): Command[] {
    return this.#list.filter((c) => c.when?.() ?? true);
  }

  async run(id: string): Promise<void> {
    const cmd = this.get(id);
    if (cmd && (cmd.when?.() ?? true)) await cmd.run();
  }

  /** 處理全域快速鍵；有對應指令時回傳該指令。 */
  match(e: KeyLike): Command | undefined {
    return this.available().find((c) => c.keys && matchKeys(c.keys, e));
  }
}

/** 指令面板的模糊比對：查詢字元依序出現在標題或群組中即算符合，連續命中分數較高。 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  let score = 0;
  let last = -2;
  let pos = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, pos);
    if (i < 0) return 0;
    score += i === last + 1 ? 3 : 1;
    last = i;
    pos = i + 1;
  }
  return score;
}
