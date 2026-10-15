import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("ESM and CommonJS entry points export a constructor without browser globals", async () => {
  assert.equal(globalThis.window, undefined);
  const esm = await import("@sverokadmin/quill-image-compress");
  const cjs = createRequire(import.meta.url)(
    "@sverokadmin/quill-image-compress",
  );
  assert.equal(typeof esm.default, "function");
  assert.equal(esm.default, esm.imageCompressor);
  assert.equal(typeof cjs.default, "function");
  assert.equal(cjs.default, cjs.imageCompressor);
  assert.equal(globalThis.imageCompressor, undefined);
});

test("the standalone browser build preserves the constructor global", async () => {
  const script = await readFile(
    new URL("../dist/quill.imageCompressor.min.js", import.meta.url),
    "utf8",
  );
  const context = {};
  runInNewContext(script, context);
  assert.equal(typeof context.imageCompressor, "function");
});
