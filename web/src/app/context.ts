/**
 * 拆到 app/ 的模組從這裡取用 main.ts 的狀態與函式（main.ts 的 `app` 物件，一開始就提供）。
 */
import type { App } from "../main.ts";

export let app: App;

export function provideApp(main: App): void {
  app = main;
}
