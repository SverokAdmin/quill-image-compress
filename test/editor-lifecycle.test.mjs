import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "MutationObserver",
  "DOMParser",
  "Range",
  "FileReader",
]) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: dom.window[name],
  });
  after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}
after(() => dom.window.close());
const { default: Quill } = await import("quill");
const { default: ImageCompressor } = await import("../dist/index.js");
const url = (name) =>
  `data:image/png;base64,${Buffer.from(name).toString("base64")}`;
const file = (name) =>
  new dom.window.File([name], `${name}.png`, { type: "image/png" });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function setup(t, options = {}) {
  t.mock.method(
    dom.window.FileReader.prototype,
    "readAsDataURL",
    function (input) {
      queueMicrotask(() => {
        Object.defineProperty(this, "result", {
          value: url(input.name.replace(/\.png$/, "")),
        });
        this.dispatchEvent(new dom.window.Event("load"));
      });
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const quill = new Quill(container, { modules: { toolbar: false } });
  t.mock.method(quill, "scrollSelectionIntoView", () => {});
  quill.setText("abcdef");
  quill.setSelection(2, 0, "silent");
  const compressor = new ImageCompressor(quill, {
    suppressErrorLogging: true,
    ...options,
  });
  t.mock.method(compressor, "downscaleImageFromUrl", async (value) => value);
  t.after(() => {
    compressor.destroy();
    container.remove();
  });
  return { quill, compressor };
}

test("real Quill queues same-cursor batches in event order without double-transforming a batch", async (t) => {
  const { quill, compressor } = setup(t);
  const gate = deferred();
  const first = compressor.fileChanged(() => gate.promise);
  const second = compressor.fileChanged([file("B")]);
  gate.resolve([file("A"), file("A2")]);
  await Promise.all([first, second]);
  assert.deepEqual(quill.getContents().ops, [
    { insert: "ab" },
    { insert: { image: url("A") } },
    { insert: { image: url("A2") } },
    { insert: { image: url("B") } },
    { insert: "cdef\n" },
  ]);
});

test("real Quill transforms pending selections through user insertions and deletions", async (t) => {
  const { quill, compressor } = setup(t);
  quill.setSelection(2, 2, "api");
  const gate = deferred();
  const operation = compressor.fileChanged(() => gate.promise);
  quill.insertText(0, "XY", "user");
  quill.deleteText(1, 1, "user");
  gate.resolve([file("A"), file("B")]);
  await operation;
  assert.deepEqual(quill.getContents().ops, [
    { insert: "Xab" },
    { insert: { image: url("A") } },
    { insert: { image: url("B") } },
    { insert: "ef\n" },
  ]);
});

test("formatter notifications do not transform positions or break subsequent real changes", async (t) => {
  const { quill, compressor } = setup(t);
  const gate = deferred();
  const operation = compressor.fileChanged(() => gate.promise);

  // blot-formatter2 emits this notification when its image overlay is hidden.
  assert.doesNotThrow(() => {
    quill.emitter.emit("text-change", 0, quill.getLength(), "api");
  });
  quill.insertText(0, "XY", "user");
  gate.resolve([file("A")]);
  await operation;

  assert.deepEqual(quill.getContents().ops, [
    { insert: "XYab" },
    { insert: { image: url("A") } },
    { insert: "cdef\n" },
  ]);
});

test("real Quill replaces selected text exactly once before the first image", async (t) => {
  const { quill, compressor } = setup(t);
  quill.setSelection(1, 3, "api");
  const deletion = t.mock.method(quill, "deleteText");
  await compressor.fileChanged([file("A"), file("B")]);
  assert.equal(deletion.mock.callCount(), 1);
  assert.deepEqual(deletion.mock.calls[0].arguments, [1, 3, "user"]);
  assert.deepEqual(quill.getContents().ops, [
    { insert: "a" },
    { insert: { image: url("A") } },
    { insert: { image: url("B") } },
    { insert: "ef\n" },
  ]);
});

test("selection-change remembers the last nonnull selection when the editor blurs", async (t) => {
  const { quill, compressor } = setup(t);
  quill.setSelection(4, 1, "api");
  quill.setSelection(null, "api");
  await compressor.fileChanged([file("A")]);
  assert.deepEqual(quill.getContents().ops, [
    { insert: "abcd" },
    { insert: { image: url("A") } },
    { insert: "f\n" },
  ]);
});

test("lazy loading runs only in its queued slot and captures selection before loading", async (t) => {
  const { quill, compressor } = setup(t);
  const gate = deferred();
  const calls = [];
  const first = compressor.fileChanged(() => {
    calls.push("A");
    return gate.promise;
  });
  const second = compressor.fileChanged(async () => {
    calls.push("B");
    return [file("B")];
  });
  quill.setSelection(5, 0, "api");
  await flush();
  assert.deepEqual(calls, ["A"]);
  gate.resolve([file("A")]);
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["A", "B"]);
  assert.deepEqual(quill.getContents().ops.slice(0, 3), [
    { insert: "ab" },
    { insert: { image: url("A") } },
    { insert: { image: url("B") } },
  ]);
});

for (const phase of ["load", "read", "decode", "upload"]) {
  test(`destroy invalidates current and queued work during ${phase}`, async (t) => {
    const gate = deferred();
    const callbacks = [];
    const { quill, compressor } = setup(t, {
      insertIntoEditor:
        phase === "upload"
          ? async () => {
              callbacks.push("started");
              await gate.promise;
            }
          : undefined,
    });
    if (phase === "read") {
      t.mock.method(
        dom.window.FileReader.prototype,
        "readAsDataURL",
        function () {
          gate.promise.then(() => {
            Object.defineProperty(this, "result", { value: url("A") });
            this.dispatchEvent(new dom.window.Event("load"));
          });
        },
      );
    }
    if (phase === "decode") {
      t.mock.method(compressor, "downscaleImageFromUrl", () => gate.promise);
    }
    const operation = compressor.fileChanged(
      phase === "load" ? () => gate.promise : [file("A"), file("A2")],
    );
    let queuedLoads = 0;
    const queued = compressor.fileChanged(async () => {
      queuedLoads++;
      return [file("B")];
    });
    await flush();
    const off = t.mock.method(quill, "off");
    compressor.destroy();
    compressor.destroy();
    gate.resolve(phase === "load" ? [file("A")] : url("A"));
    await Promise.all([operation, queued]);
    await compressor.fileChanged(async () => {
      queuedLoads++;
      return [file("C")];
    });
    await compressor.insertToEditor(url("D"), file("D"));
    compressor.selectLocalImage();
    assert.equal(queuedLoads, 0);
    assert.deepEqual(quill.getContents().ops, [{ insert: "abcdef\n" }]);
    assert.deepEqual(callbacks, phase === "upload" ? ["started"] : []);
    assert.deepEqual(
      off.mock.calls.map((call) => call.arguments[0]),
      ["selection-change", "text-change"],
    );
    assert.equal(document.querySelector("input[type=file]"), null);
  });
}

test("custom insertion owns replacement and selection without default editor edits", async (t) => {
  const calls = [];
  const { quill, compressor } = setup(t, {
    insertIntoEditor: async (value) => {
      calls.push(value);
    },
  });
  quill.setSelection(1, 3, "api");
  await compressor.fileChanged([file("A"), file("B")]);
  assert.deepEqual(calls, [url("A"), url("B")]);
  assert.deepEqual(quill.getContents().ops, [{ insert: "abcdef\n" }]);
});

test("event errors that settle after teardown do not invoke onError", async (t) => {
  const gate = deferred();
  const errors = [];
  const { quill, compressor } = setup(t, {
    insertIntoEditor: () => gate.promise,
    onError: (error) => errors.push(error),
  });
  const event = new dom.window.Event("paste", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", {
    value: { files: [file("A")] },
  });
  quill.root.dispatchEvent(event);
  await flush();
  compressor.destroy();
  gate.reject(new Error("late upload failure"));
  await flush();
  assert.deepEqual(errors, []);
});
