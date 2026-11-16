/**
 * 常用的 Wiki（存在本機）：Wiki 選單只列常用的。
 */
import { parseFavorites } from "../favorites.ts";
import * as storage from "../storage.ts";

function list(key: string): { load(): string[]; save(values: string[]): void } {
  return {
    load: () => parseFavorites(storage.load(key)),
    save: (values) => (values.length ? storage.save(key, JSON.stringify(values)) : storage.remove(key)),
  };
}

/** 常用的 Wiki（id）。 */
export const favoriteWikis = list("ado-favorite-wikis");
