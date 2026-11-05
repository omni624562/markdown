import assert from "node:assert/strict";
import { test } from "node:test";
import { blockRemoteInMermaid, cssLoadsRemote, isRemoteUrl, srcsetIsRemote, stripRemoteCss } from "./remote-images.ts";

/** 桌面版的頁面網址：Windows 是 http://tauri.localhost，macOS、Linux 是 tauri://localhost；網頁版是一般網址。 */
const WINDOWS = "http://tauri.localhost/index.html";
const MAC = "tauri://localhost/index.html";
const WEB = "https://app.test/index.html";

test("遠端網址照瀏覽器的解析判斷：少了 // 的寫法、大寫、空白、換行都算", () => {
  // 不管頁面網址是什麼都會連出去的寫法。
  for (const base of [WINDOWS, MAC, WEB]) {
    for (const src of ["https://evil.example/p.png", "HtTp://evil.example/p.png", " https://evil.example/p.png", "h\nttps://evil.example/p.png", "HTTP://evil.example/p.png"]) {
      assert.ok(isRemoteUrl(src, base), `${base}：${JSON.stringify(src)}`);
    }
  }
  // 少了 // 的寫法：協定和頁面不同時是完整網址（桌面版的頁面是 http://tauri.localhost 或 tauri://localhost）。
  for (const src of ["https:evil.example/p.png", "HTTPS:evil.example/p.png", "https:;@evil.example/p.png"]) {
    assert.ok(isRemoteUrl(src, WINDOWS), src);
    assert.ok(isRemoteUrl(src, MAC), src);
    assert.ok(!isRemoteUrl(src, WEB), src); // 協定相同：相對路徑
  }
  assert.ok(isRemoteUrl("http:evil.example/p.png", MAC));
  assert.ok(isRemoteUrl("http:evil.example/p.png", WEB));
  assert.ok(!isRemoteUrl("http:evil.example/p.png", WINDOWS));
  // 省略協定（//主機）：跟著頁面的協定，http(s) 頁面才會連到網路。
  for (const src of ["//evil.example/p.png", " //evil.example/p.png", "\t//evil.example/p.png", "/\t/evil.example/p.png", "///evil.example/p.png"]) {
    assert.ok(isRemoteUrl(src, WINDOWS), JSON.stringify(src));
    assert.ok(isRemoteUrl(src, WEB), JSON.stringify(src));
    assert.ok(!isRemoteUrl(src, MAC), JSON.stringify(src));
  }
});

test("反斜線：http(s) 頁面（Windows、網頁版）當成 /，tauri: 頁面是一般字元", () => {
  for (const src of ["\\\\evil.example\\a.png", "/\\evil.example/a.png", "\\/evil.example/a.png"]) {
    assert.ok(isRemoteUrl(src, WINDOWS), src);
    assert.ok(isRemoteUrl(src, WEB), src);
    assert.ok(!isRemoteUrl(src, MAC), src);
  }
});

test("內嵌、相對路徑、同一個網站與程式自己的圖片不算遠端", () => {
  for (const base of [WINDOWS, MAC, WEB]) {
    for (const src of [
      "data:image/png;base64,AAAA",
      "blob:http://tauri.localhost/1234",
      "img/a.png",
      "./img/a.png",
      "../a.png",
      "/a.png",
      "#top",
      "?x=1",
      "",
      "mdimg://localhost/C%3A%5CUsers%5Cme%5Ca.png",
      "http://mdimg.localhost/C%3A%5CUsers%5Cme%5Ca.png",
      "javascript:alert(1)",
      "file:///C:/Users/me/a.png",
      "https://[bad",
      "https:",
    ]) {
      assert.ok(!isRemoteUrl(src, base), `${base}：${JSON.stringify(src)}`);
    }
  }
  assert.ok(!isRemoteUrl("http://tauri.localhost/assets/a.png", WINDOWS));
  assert.ok(!isRemoteUrl("https://app.test/a.png", WEB));
  assert.ok(isRemoteUrl("https://app.test/a.png", WINDOWS));
});

test("srcset：每個可能的網址都檢查", () => {
  assert.ok(srcsetIsRemote("a.png 1x, https:evil.example/b.png 2x", WINDOWS));
  assert.ok(srcsetIsRemote("a.png 1x,//evil.example/b.png 2x", WINDOWS));
  assert.ok(srcsetIsRemote("https:,@evil.example/b.png 1x", WINDOWS));
  assert.ok(!srcsetIsRemote("a.png 1x, b.png 2x", WINDOWS));
  assert.ok(!srcsetIsRemote("data:image/png;base64,AAAA 1x", WINDOWS));
});

test("CSS 會下載東西的寫法：url()、image-set()、@import、跳脫字元", () => {
  for (const css of [
    "background: url(https://evil.example/b.png)",
    "background: URL( 'https:evil.example/b.png' )",
    "background: url(//evil.example/b.png)",
    "background: url(\\68ttps://evil.example/b.png)",
    "background: \\75 rl(https://evil.example/b.png)",
    "background: \\000075rl(evil.png)",
    'background-image: image-set("https://evil.example/b.png" 1x)',
    'background-image: -webkit-image-set("//evil.example/b.png" 1x)',
    "@import 'https://evil.example/x.css';",
    "@\\69mport 'https://evil.example/x.css';",
    "cursor: url(img.png), auto",
  ]) {
    assert.ok(cssLoadsRemote(css), css);
  }
  for (const css of ["fill: url(#grad)", "fill: url( '#grad' )", "background: url(data:image/png;base64,AAAA)", "color: red", "transform: translate(1px, 2px)"]) {
    assert.ok(!cssLoadsRemote(css), css);
  }
});

test("CSS 裡會下載東西的宣告整個拿掉，其他的保留", () => {
  assert.equal(stripRemoteCss(".a { fill: url(https://evil.example/b.png) }"), ".a {}");
  assert.equal(stripRemoteCss(`.a { color: red; background: url( "//evil.example/b.png" ) }`), ".a { color: red;}");
  assert.equal(stripRemoteCss("@import url(https://evil.example/x.css); .a{}"), "; .a{}");
  assert.equal(stripRemoteCss(".a{background:url(\\68ttps://evil.example/b.png)}"), ".a{}");
  assert.equal(stripRemoteCss('.a{background-image:image-set("https://evil.example/b.png" 1x)}'), ".a{}");
  // 想用分號把網址切開也一樣擋得住。
  const tricky = 'a: url(a"); b: url("https:[);@evil.example/x")';
  assert.ok(!cssLoadsRemote(stripRemoteCss(tricky)));
  // 本機與內嵌的不動。
  assert.equal(stripRemoteCss(".a { fill: url(#grad) }"), ".a { fill: url(#grad) }");
  assert.equal(stripRemoteCss(".a { fill: url(data:image/png;base64,AAAA) }"), ".a { fill: url(data:image/png;base64,AAAA) }");
});

test("流程圖原始碼裡會下載的遠端網址先拿掉，連結不動", () => {
  const code = [
    '%%{init: {"themeCSS": ".node rect { fill: url(https://evil.example/beacon) }"}}%%',
    "graph TD",
    '  A@{ img: "https:evil.example/p.png", label: "圖" }',
    "  B[\"<img src='https:evil.example/x.png'>\"]",
    "  C[\"<img src='&#104;ttps:evil.example/y.png'>\"]",
    "  C2[\"<img src='#104;ttps:evil.example/y2.png'>\"]",
    "  D[\"<span style='background:url(https:evil.example/z.png)'>字</span>\"]",
    "  E[\"<img srcset='https:evil.example/s.png 1x'>\"]",
    '  F@{ img: "\\x68ttps://evil.example/q.png" }',
    "  G@{ img: https://evil.example/plain.png, label: x }",
    "  H[\"<img src='img/local.png'>\"]",
    "  I[\"<img src=https:'@evil.example/u.png>\"]",
    '  click A "https://example.com/doc"',
  ].join("\n");
  const out = blockRemoteInMermaid(code);
  for (const line of out.split("\n")) assert.ok(!cssLoadsRemote(line), line);
  for (const m of out.matchAll(/(?:src|img)\s*[=:]\s*["']?([^"'\s,}]*)/g)) assert.ok(!isRemoteUrl(m[1], WINDOWS) && !/&|\\/.test(m[1]), m[0]);
  assert.ok(!/srcset='[^']+'/.test(out), out);
  assert.ok(!out.includes("q.png") && !out.includes("plain.png") && !out.includes("u.png") && !out.includes("y2.png"), out);
  assert.ok(out.includes("<img src='img/local.png'>"));
  assert.ok(out.includes('click A "https://example.com/doc"'));
});

test("流程圖的樣式（style、classDef）裡的 url() 失效，一般文字不動", () => {
  const code = [
    "graph TD",
    "  A[docker image(s)]-->B[url(說明)]",
    "  style A background:url(\\68ttps://evil.example/a.png),color:red",
    "  classDef c background-image:image-set('https://evil.example/b.png' 1x)",
    "  classDef d fill:url(#grad)",
  ].join("\n");
  const out = blockRemoteInMermaid(code).split("\n");
  assert.equal(out[1], "  A[docker image(s)]-->B[url(說明)]");
  assert.ok(!cssLoadsRemote(out[2]) && out[2].includes("color:red"), out[2]);
  assert.ok(!cssLoadsRemote(out[3]), out[3]);
  assert.equal(out[4], "  classDef d fill:url(#grad)");
});

test("循序圖 properties 的 icon（JSON 跳脫寫法也算）", () => {
  const out = blockRemoteInMermaid('sequenceDiagram\n  participant A\n  properties A: {"icon": "\\u0068ttps://evil.example/i.png"}\n  A->>A: hi');
  assert.ok(!out.includes("evil.example"), out);
  assert.ok(out.includes("A->>A: hi"));
});

test("前一個屬性值裡的文字也檢查；SVG 屬性的 url() 也擋", () => {
  // 標籤外面的 `title='…'` 只是文字，裡面的 <img> 是真的標籤。
  const nested = "graph TD\n  A[\"src='x <img src=https:evil.example/n.png>'\"]";
  assert.ok(!blockRemoteInMermaid(nested).includes("evil.example"), blockRemoteInMermaid(nested));
  const fill = "graph TD\n  A[\"<svg><rect fill='url(https:evil.example/f.svg#p)' cursor='url(https://evil.example/c.png),auto'/></svg>\"]";
  assert.ok(!blockRemoteInMermaid(fill).includes("evil.example"), blockRemoteInMermaid(fill));
  const plain = "graph TD\n  A[\"<span title='a &amp; b' class='x'>字</span>\"]";
  assert.equal(blockRemoteInMermaid(plain), plain);
});

test("連結的 href 不動，除非圖裡有 <image> 這類會用 href 載入的標籤", () => {
  const link = "graph TD\n  A[\"<a href='https://example.com/doc'>文件</a>\"]";
  assert.equal(blockRemoteInMermaid(link), link);
  const image = "graph TD\n  A[\"<svg><image href='https:evil.example/i.png'/></svg>\"]";
  assert.ok(!blockRemoteInMermaid(image).includes("evil.example"));
});
