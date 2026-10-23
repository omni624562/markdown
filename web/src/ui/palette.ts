import { t } from "../i18n.ts";
import { type Command, type Commands, formatKeys, fuzzyScore } from "../commands.ts";
import { Picker } from "./picker.ts";

/**
 * 指令面板（Ctrl/⌘+Shift+P）：輸入關鍵字即可找到所有功能並看到對應的快速鍵。
 */
export class Palette {
  #picker: Picker<Command>;

  constructor(commands: Commands) {
    this.#picker = new Picker<Command>({
      label: t("指令面板"),
      placeholder: t("輸入指令名稱，例如「匯出」「表格」「深色」"),
      empty: t("找不到符合的指令"),
      query: (q) =>
        commands
          .available()
          .filter((c) => c.id !== "palette")
          .map((c) => ({ c, score: Math.max(fuzzyScore(q, c.title), fuzzyScore(q, `${c.group} ${c.title}`) - 1) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.c),
      render: (c) => ({ title: c.title, detail: c.group, icon: c.icon, keys: (c.keys ?? c.shownKeys) && formatKeys((c.keys ?? c.shownKeys)!) }),
      pick: (c) => void commands.run(c.id),
    });
  }

  open(): void {
    this.#picker.open();
  }
}
