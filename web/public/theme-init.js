// 在畫面繪製前套用主題，避免深色模式使用者看到白色閃爍（index.html 同步載入）。
try {
  const t = localStorage.getItem("md-editor:theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
