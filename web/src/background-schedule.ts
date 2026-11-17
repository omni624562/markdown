/** 背景檢查的時間表（app/background-checks.ts 用；不碰畫面，方便測試）。 */

/** 下一次檢查要等多久（毫秒）：設定的間隔（最短 10 分鐘），前後錯開最多 10%。`random` 是 0～1。 */
export function nextDelay(minutes: number, random = Math.random()): number {
  const base = Math.max(10, minutes) * 60_000;
  return Math.round(base * (0.9 + 0.2 * random));
}
