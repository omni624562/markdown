import assert from "node:assert/strict";
import { test } from "node:test";
import { posAt } from "./editor-pos.ts";

test("posAt：照常回傳位置；CodeMirror 內部出錯時回傳 null，不往外丟", () => {
  assert.equal(posAt({ posAtCoords: () => 42 }, 10, 20), 42);
  assert.equal(posAt({ posAtCoords: () => null }, 10, 20), null);
  const broken = {
    posAtCoords(): number | null {
      throw new TypeError("Cannot read properties of null (reading 'length')");
    },
  };
  assert.equal(posAt(broken, 10, 20), null);
});
