/**
 * 測試用：在 Node 載入 WebAssembly 模組（瀏覽器由 main.ts 載入）。要先執行 `npm run wasm`。
 */
import { readFileSync } from "node:fs";
import { initSync } from "../pkg/md_wasm.js";

initSync({ module: readFileSync(new URL("../pkg/md_wasm_bg.wasm", import.meta.url)) });

export * from "../pkg/md_wasm.js";
