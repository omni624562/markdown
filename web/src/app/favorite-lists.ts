/**
 * 常用的專案、Wiki（存在本機）：工作板的專案選單、Wiki 選單只列常用的；工作項目的專案篩選把常用的排前面。
 */
import { parseFavorites } from "../favorites.ts";
import * as storage from "../storage.ts";

function list(key: string): { load(): string[]; save(values: string[]): void } {
  return {
    load: () => parseFavorites(storage.load(key)),
    save: (values) => (values.length ? storage.save(key, JSON.stringify(values)) : storage.remove(key)),
  };
}

/** 常用的專案（名稱）。 */
export const favoriteProjects = list("ado-favorite-projects");
/** 常用的 Wiki（id）。 */
export const favoriteWikis = list("ado-favorite-wikis");
