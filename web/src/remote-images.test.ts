import assert from "node:assert/strict";
import { test } from "node:test";
import { blockRemoteInMermaid, stripRemoteCss } from "./remote-images.ts";

test("CSS 裡的遠端網址換成不會連線的值", () => {
  assert.equal(stripRemoteCss(".a { fill: url(https://evil.example/b.png) }"), ".a { fill: none }");
  assert.equal(stripRemoteCss(`.a { background: url( "//evil.example/b.png" ) }`), ".a { background: none }");
  assert.equal(stripRemoteCss("@import url(https://evil.example/x.css); .a{}"), " .a{}");
  // 本機與內嵌的不動。
  assert.equal(stripRemoteCss(".a { fill: url(#grad) }"), ".a { fill: url(#grad) }");
  assert.equal(stripRemoteCss(".a { fill: url(data:image/png;base64,AAAA) }"), ".a { fill: url(data:image/png;base64,AAAA) }");
});

test("流程圖原始碼裡會下載的遠端網址先拿掉，連結不動", () => {
  const code = [
    '%%{init: {"themeCSS": ".node rect { fill: url(https://evil.example/beacon) }"}}%%',
    "graph TD",
    '  A@{ img: "https://evil.example/p.png", label: "圖" }',
    "  B[\"<img src='https://evil.example/x.png'>\"]",
    '  click A "https://example.com/doc"',
  ].join("\n");
  const out = blockRemoteInMermaid(code);
  assert.ok(!/(?:https?:)?\/\/evil\.example/.test(out), out);
  assert.ok(out.includes('click A "https://example.com/doc"'));
});
