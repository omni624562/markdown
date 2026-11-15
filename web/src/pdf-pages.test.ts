import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfPages } from "./pdf-pages.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

test("數頁面物件：/Type /Page 算，/Type /Pages（頁面樹）不算", () => {
  const pdf = "%PDF-1.4\n1 0 obj<</Type /Pages /Kids[2 0 R 3 0 R]>>\n2 0 obj<</Type /Page>>\n3 0 obj<</Type/Page /Parent 1 0 R>>\n";
  assert.equal(pdfPages(bytes(pdf)), 2);
});

test("數不到頁面物件（壓縮起來的）：用大小估，每頁約 100 KB，至少 1 頁", () => {
  assert.equal(pdfPages(bytes("%PDF-1.7\n")), 1);
  assert.equal(pdfPages(new Uint8Array(1_250_000)), 13);
});
