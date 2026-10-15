import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://editor.test/",
});
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
const originalStyle = globalThis.getComputedStyle;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
after(() => {
  globalThis.getComputedStyle = originalStyle;
  dom.window.close();
});
const { default: Quill } = await import("quill");
const { default: ImageCompressor } = await import("../dist/index.js");
const file = (name) => new dom.window.File([name], name, { type: "image/png" });
const encoded = (name) =>
  `data:image/png;base64,${Buffer.from(name).toString("base64")}`;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const response = (name) => ({ ok: true, blob: async () => file(name) });

function setup(t, options = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const quill = new Quill(container, { modules: { toolbar: false } });
  t.mock.method(quill, "scrollSelectionIntoView", () => {});
  quill.setText("abcdef");
  quill.setSelection(1, 0, "silent");
  const errors = [];
  const compressor = new ImageCompressor(quill, {
    suppressErrorLogging: true,
    ignoreImageTypes: ["image/png"],
    onError: (error) => errors.push(error),
    ...options,
  });
  const operations = [];
  const original = compressor.fileChanged.bind(compressor);
  t.mock.method(compressor, "fileChanged", (...args) => {
    const operation = original(...args);
    operations.push(operation);
    return operation;
  });
  t.after(() => {
    compressor.destroy();
    container.remove();
  });
  return { quill, compressor, operations, errors };
}

function dispatch(
  root,
  type = "drop",
  { files = [], url = "", html = "", text = "", uri = "" } = {},
) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  const data = {
    files,
    items: [],
    getData: (format) =>
      ({
        URL: url,
        "text/html": html,
        "text/plain": text,
        "text/uri-list": uri,
      })[format] ?? "",
  };
  Object.defineProperty(
    event,
    type === "paste" ? "clipboardData" : "dataTransfer",
    { value: data },
  );
  root.dispatchEvent(event);
  return event;
}

function images(quill) {
  return quill
    .getContents()
    .ops.filter((op) => op.insert?.image)
    .map((op) => op.insert.image);
}

test("ordinary hyperlinks, text and nonimage files remain native drops", async (t) => {
  const { quill, operations } = setup(t);
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected fetch");
  });
  let bubbles = 0;
  // Stop after observing propagation, before Quill's native handler needs layout APIs.
  quill.root.addEventListener(
    "drop",
    (event) => {
      bubbles++;
      event.stopImmediatePropagation();
    },
    true,
  );
  for (const data of [
    { url: "https://example.test/article" },
    {
      url: "https://example.test/article?file=photo.png",
      html: '<a href="https://example.test/article">link</a>',
    },
    {
      url: "https://example.test/article",
      html: '<img src="https://example.test/other">',
    },
    { text: "ordinary text" },
    {
      files: [
        new dom.window.File(["text"], "note.txt", { type: "text/plain" }),
      ],
    },
  ])
    assert.equal(dispatch(quill.root, "drop", data).defaultPrevented, false);
  await flush();
  assert.equal(bubbles, 5);
  assert.equal(operations.length, 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("image URL identification accepts data, pathname extensions and matching HTML image sources", async (t) => {
  for (const data of [
    { url: encoded("data") },
    { url: "https://example.test/photo.PNG?size=2#preview" },
    { uri: "# image\r\nhttps://example.test/photo.png" },
    {
      url: "https://example.test/image?id=7",
      html: '<img src="https://example.test/image?id=7">',
    },
  ]) {
    const state = setup(t);
    t.mock.method(globalThis, "fetch", async () => response("remote"));
    assert.equal(
      dispatch(state.quill.root, "drop", data).defaultPrevented,
      true,
    );
    assert.equal(state.operations.length, 1, "reserve the queue synchronously");
    await Promise.all(state.operations);
    assert.deepEqual(images(state.quill), [encoded("remote")]);
  }
});

for (const firefox of [false, true]) {
  test(`${firefox ? "Firefox" : "WebKit"} point caret overrides the existing Quill selection`, async (t) => {
    const state = setup(t);
    const node = state.quill.root.firstChild.firstChild;
    const caret = document.createRange();
    caret.setStart(node, 4);
    caret.collapse(true);
    Object.defineProperty(document, "caretRangeFromPoint", {
      configurable: true,
      value: firefox ? undefined : () => caret,
    });
    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: () => ({ offsetNode: node, offset: 4 }),
    });
    t.after(() => {
      delete document.caretRangeFromPoint;
      delete document.caretPositionFromPoint;
    });
    assert.equal(state.quill.getSelection().index, 1);
    dispatch(state.quill.root, "drop", { files: [file("caret")] });
    await Promise.all(state.operations);
    assert.deepEqual(state.quill.getContents().ops, [
      { insert: "abcd" },
      { insert: { image: encoded("caret") } },
      { insert: "ef\n" },
    ]);
  });
}

test("a slow remote drop reserves its place before a subsequent local drop", async (t) => {
  const state = setup(t);
  const gate = deferred();
  const fetch = t.mock.method(globalThis, "fetch", () => gate.promise);
  dispatch(state.quill.root, "drop", {
    url: "https://example.test/remote.png",
  });
  assert.equal(state.operations.length, 1);
  assert.equal(fetch.mock.callCount(), 0, "fetch runs lazily inside the queue");
  dispatch(state.quill.root, "drop", { files: [file("local")] });
  await flush();
  assert.deepEqual(images(state.quill), []);
  gate.resolve(response("remote"));
  await Promise.all(state.operations);
  assert.deepEqual(images(state.quill), [encoded("remote"), encoded("local")]);
});

test("two remote drops retain event order when the second response is ready first", async (t) => {
  const state = setup(t);
  const first = deferred();
  const second = deferred();
  const fetch = t.mock.method(globalThis, "fetch", (url) =>
    url.endsWith("first.png") ? first.promise : second.promise,
  );
  dispatch(state.quill.root, "drop", { url: "https://example.test/first.png" });
  dispatch(state.quill.root, "drop", {
    url: "https://example.test/second.png",
  });
  assert.equal(state.operations.length, 2);
  second.resolve(response("second"));
  await flush();
  assert.equal(
    fetch.mock.callCount(),
    1,
    "the second fetch must wait for the first queue slot",
  );
  assert.deepEqual(images(state.quill), []);
  first.resolve(response("first"));
  await Promise.all(state.operations);
  assert.deepEqual(images(state.quill), [encoded("first"), encoded("second")]);
});

test("destroy aborts active fetches, skips queued fetches and suppresses teardown errors", async (t) => {
  const state = setup(t);
  let signal;
  const fetch = t.mock.method(globalThis, "fetch", (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  });
  dispatch(state.quill.root, "drop", {
    url: "https://example.test/active.png",
  });
  dispatch(state.quill.root, "drop", {
    url: "https://example.test/queued.png",
  });
  await flush();
  assert.equal(signal.aborted, false);
  state.compressor.destroy();
  assert.equal(signal.aborted, true);
  await Promise.allSettled(state.operations);
  await flush();
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(images(state.quill), []);
  assert.deepEqual(state.errors, []);
  // Observe whether our capture listener is gone without invoking Quill's native uploader.
  state.quill.root.addEventListener(
    "paste",
    (event) => event.stopImmediatePropagation(),
    true,
  );
  assert.equal(
    dispatch(state.quill.root, "paste", { files: [file("late")] })
      .defaultPrevented,
    false,
  );
  assert.equal(state.operations.length, 2);
});

test("destroy also prevents insertion when a fetch ignores abort and resolves late", async (t) => {
  const state = setup(t);
  const gate = deferred();
  t.mock.method(globalThis, "fetch", () => gate.promise);
  dispatch(state.quill.root, "drop", { url: "https://example.test/late.png" });
  await flush();
  state.compressor.destroy();
  gate.resolve(response("late"));
  await Promise.all(state.operations);
  assert.deepEqual(images(state.quill), []);
  assert.deepEqual(state.errors, []);
});
