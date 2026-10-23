/**
 * 專案清單的分組、搜尋與顯示文字（切換器與專案總覽共用）。
 */
import { collator } from "./collator.ts";
import type { Project } from "./desktop.ts";

export const PROJECT_COLORS: { id: string; label: string }[] = [
  { id: "red", label: "紅" },
  { id: "orange", label: "橘" },
  { id: "yellow", label: "黃" },
  { id: "green", label: "綠" },
  { id: "teal", label: "青" },
  { id: "blue", label: "藍" },
  { id: "purple", label: "紫" },
  { id: "pink", label: "粉紅" },
  { id: "gray", label: "灰" },
];

export const PINNED_SECTION = "釘選";
export const RECENT_SECTION = "最近開啟";

export interface ProjectSection {
  title: string;
  items: Project[];
}

/** 搜尋字串的每個詞都要出現在名稱、群組或路徑中（不分大小寫）。 */
export function matchesProject(p: Project, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${p.label} ${p.group ?? ""} ${p.path}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * 分成「釘選」、各群組（依名稱排序）、「最近開啟」；每一區維持原本（最近開啟）的順序。
 * 釘選的專案只出現在「釘選」。
 */
export function projectSections(list: Project[], query = ""): ProjectSection[] {
  const pinned: Project[] = [];
  const groups = new Map<string, Project[]>();
  const recent: Project[] = [];
  for (const p of list) {
    if (!matchesProject(p, query)) continue;
    if (p.pinned) pinned.push(p);
    else if (p.group) {
      const items = groups.get(p.group);
      if (items) items.push(p);
      else groups.set(p.group, [p]);
    } else recent.push(p);
  }
  const sections: ProjectSection[] = [];
  if (pinned.length) sections.push({ title: PINNED_SECTION, items: pinned });
  for (const title of [...groups.keys()].sort(collator.compare)) sections.push({ title, items: groups.get(title)! });
  if (recent.length) sections.push({ title: RECENT_SECTION, items: recent });
  return sections;
}

/** 已經用過的群組名稱（排序好），給輸入群組時挑選。 */
export function projectGroups(list: Project[]): string[] {
  return [...new Set(list.map((p) => p.group).filter((g): g is string => !!g))].sort(collator.compare);
}

/** 同一個資料夾？Windows 的路徑不分大小寫。 */
export function samePath(a: string, b: string): boolean {
  return a === b || (/^[a-z]:[\\/]|^\\\\/i.test(a) && a.toLowerCase() === b.toLowerCase());
}
