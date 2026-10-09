import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../src/public/index.html", import.meta.url), "utf8");

test("the public board names loading, empty, and error beside the settled-bid line", () => {
  assert.match(html, /#1 is the highest settled bid/);
  assert.match(html, /Loading the board\./);
  assert.match(html, /board is empty/);
  assert.match(html, /Could not load the board\. Nothing was changed\./);
  assert.match(html, /<noscript>/);
});
