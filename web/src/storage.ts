/**
 * localStorage 的安全包裝：無痕模式或封鎖網站資料時存取會丟例外，這裡一律吞掉，
 * 讓編輯器在沒有儲存空間時仍可正常使用。
 */
const PREFIX = "md-editor:";

export function load(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string): boolean {
  try {
    localStorage.setItem(PREFIX + key, value);
    return true;
  } catch {
    return false;
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // 無法存取儲存空間時忽略。
  }
}
