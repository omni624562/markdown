// 在畫面繪製前套用主題與配色，避免深色模式使用者看到白色閃爍、或先閃一下別的配色
// （index.html 與 terminal.html 同步載入；邏輯和 src/palette.ts 一致）。
try {
  const root = document.documentElement;
  const t = localStorage.getItem("md-editor:theme");
  if (t === "light" || t === "dark") root.dataset.theme = t;
  const palettes = ["forest", "mint", "matcha", "night", "clean", "classic", "project", "contrast"];
  const p = localStorage.getItem("md-editor:palette");
  root.dataset.palette = palettes.includes(p) ? p : "forest";
  // 自訂的強調色：src/palette.ts 存好算好的變數，這裡只接受 light-dark(#rrggbb, #rrggbb)。
  const vars = JSON.parse(localStorage.getItem("md-editor:accent-vars") || "{}");
  for (const name of ["--accent", "--accent-fg"]) {
    const v = vars[name];
    if (typeof v === "string" && /^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/.test(v)) root.style.setProperty(name, v);
  }
} catch {}
