/**
 * 拆到 app/ 的模組從這裡取用 main.ts 的狀態與函式（main.ts 的 `app` 物件，一開始就提供）。
 *
 * app/ 的模組彼此 import 形成一個環，main.ts 要等所有模組載入完才呼叫 `provideApp`；在那之前（模組最上層）
 * 取用 `app.xxx` 會拿到還沒設定的東西，只在函式裡（事件、指令執行時）取用才安全。
 * 提供之前 `app` 是一個一碰就丟出清楚錯誤的代理物件，不會只看到「app is undefined」；
 * `provideApp` 之後換成真正的物件，之後的取用沒有額外成本。`app/context.test.ts` 也會掃描所有模組，
 * 禁止在最上層直接取用。
 */
import type { App } from "../main.ts";

// i18n-ignore：給開發者看的錯誤訊息
const NOT_READY = "app/context.ts：main.ts 還沒提供 app（provideApp），不能在模組最上層取用 app.{key}；改在函式裡取用。";

export let app: App = new Proxy({} as App, {
  get(_target, key) {
    throw new Error(NOT_READY.replace("{key}", String(key)));
  },
  set(_target, key) {
    throw new Error(NOT_READY.replace("{key}", String(key)));
  },
});

export function provideApp(main: App): void {
  app = main;
}
