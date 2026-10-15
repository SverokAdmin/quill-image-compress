import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { JSDOM } from "jsdom";

function replaceGlobal(name, value, cleanup) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  cleanup(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}

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
]) {
  replaceGlobal(name, dom.window[name], after);
}
replaceGlobal(
  "getComputedStyle",
  dom.window.getComputedStyle.bind(dom.window),
  after,
);
after(() => dom.window.close());
const { default: ImageCompressor } = await import("../dist/index.js");
const { default: Quill } = await import("quill");

const file = (name = "first.png", type = "image/png") =>
  new dom.window.File([name], name, { type });
const encoded = (name, type = "image/jpeg") =>
  `data:${type};base64,${Buffer.from(name).toString("base64")}`;

function media(t, { manual = false } = {}) {
  const readers = [];
  const images = [];
  replaceGlobal(
    "FileReader",
    class {
      listeners = new Map();
      addEventListener(name, listener) {
        this.listeners.set(name, listener);
      }
      removeEventListener(name) {
        this.listeners.delete(name);
      }
      readAsDataURL(input) {
        this.file = input;
        readers.push(this);
        if (!manual) queueMicrotask(() => this.complete());
      }
      complete() {
        this.result = encoded(this.file.name ?? "remote", this.file.type);
        this.listeners.get("load")?.();
        this.onload?.();
      }
    },
    (fn) => t.after(fn),
  );
  replaceGlobal(
    "Image",
    class {
      naturalWidth = 100;
      naturalHeight = 80;
      set src(value) {
        this.url = value;
        images.push(this);
        if (!manual) queueMicrotask(() => this.complete());
      }
      complete() {
        this.onload();
      }
    },
    (fn) => t.after(fn),
  );
  const createElement = document.createElement.bind(document);
  t.mock.method(document, "createElement", (tag, ...args) => {
    if (tag !== "canvas") return createElement(tag, ...args);
    let image;
    return {
      getContext: () => ({
        fillRect() {},
        drawImage(value) {
          image = value;
        },
      }),
      toDataURL: (type) => image.url.replace(/^data:[^;]+/, `data:${type}`),
    };
  });
  return { readers, images };
}

function setup(t, options = {}, behavior = {}) {
  const mocks = media(t, behavior);
  const root = document.createElement("div");
  document.body.append(root);
  const handlers = {};
  const inserts = [];
  const selections = [];
  let selection = { index: 3, length: 0 };
  const quill = {
    on() {},
    off() {},
    deleteText() {},
    root,
    getModule: (name) =>
      name === "toolbar"
        ? {
            addHandler(name, handler) {
              handlers[name] = handler;
            },
          }
        : undefined,
    getSelection: () => selection,
    getLength: () => 21,
    insertEmbed: (...args) => inserts.push(args),
    setSelection(range, source) {
      selection = { ...range };
      selections.push([{ ...range }, source]);
    },
  };
  const compressor = new ImageCompressor(quill, {
    suppressErrorLogging: true,
    ...options,
  });
  t.after(() => {
    compressor.destroy();
    root.remove();
  });
  const operations = track(t, compressor);
  return {
    ...mocks,
    root,
    quill,
    compressor,
    handlers,
    inserts,
    selections,
    operations,
    move: (value) => {
      selection = value;
    },
  };
}

function track(t, compressor) {
  const operations = [];
  const original = compressor.fileChanged.bind(compressor);
  t.mock.method(compressor, "fileChanged", (...args) => {
    const operation = original(...args);
    operations.push(operation);
    return operation;
  });
  return operations;
}

function dispatch(
  root,
  type,
  { files = [], items = [], url = "", text = "" } = {},
) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  const data = {
    files,
    items,
    getData: (format) =>
      format === "URL" ? url : format === "text/plain" ? text : "",
  };
  Object.defineProperty(
    event,
    type === "paste" ? "clipboardData" : "dataTransfer",
    { value: data },
  );
  root.dispatchEvent(event);
  return event;
}

test("toolbar captures the selection before the file dialog and preserves it through read/decode", async (t) => {
  const state = setup(t, {}, { manual: true });
  state.move({ index: 4, length: 2 });
  state.handlers.image();
  const input = document.querySelector("input[type=file]");
  assert.ok(input);
  assert.equal(input.accept, "image/*");
  state.move({ index: 12, length: 0 });
  Object.defineProperty(input, "files", { value: [file()] });
  input.dispatchEvent(new dom.window.Event("change"));
  assert.equal(input.isConnected, false);
  await flush();
  assert.equal(state.readers.length, 1);
  state.move({ index: 15, length: 0 });
  state.readers[0].complete();
  await flush();
  assert.equal(state.images.length, 1);
  state.move({ index: 18, length: 0 });
  state.images[0].complete();
  await state.operations[0];
  assert.deepEqual(state.inserts, [[4, "image", encoded("first.png"), "user"]]);
  assert.deepEqual(state.selections, [[{ index: 5, length: 0 }, "api"]]);
});

test("canceling the toolbar chooser removes it without reading or inserting", (t) => {
  const state = setup(t);
  state.handlers.image();
  const input = document.querySelector("input[type=file]");
  input.dispatchEvent(new dom.window.Event("cancel"));
  assert.equal(input.isConnected, false);
  assert.equal(state.readers.length, 0);
  assert.deepEqual(state.inserts, []);
});

test("multiple files retain order and a subsequent batch uses the updated selection", async (t) => {
  const state = setup(t);
  await state.compressor.fileChanged([file("one.png"), file("two.png")]);
  await state.compressor.fileChanged([file("three.png")]);
  assert.deepEqual(state.inserts, [
    [3, "image", encoded("one.png"), "user"],
    [4, "image", encoded("two.png"), "user"],
    [5, "image", encoded("three.png"), "user"],
  ]);
  assert.deepEqual(
    state.readers.map((reader) => reader.file.name),
    ["one.png", "two.png", "three.png"],
  );
});

test("queued uploads wait for async insertion and recover after a rejected upload", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const failure = new Error("upload failed");
  const calls = [];
  const state = setup(t, {
    async insertIntoEditor(url, blob, editor) {
      calls.push([url, blob.type, editor]);
      if (calls.length === 1) {
        await gate;
        throw failure;
      }
    },
  });
  const first = state.compressor.fileChanged([file("one.png")]);
  const rejection = assert.rejects(first, (error) => error === failure);
  const second = state.compressor.fileChanged([
    file("two.png"),
    file("three.png"),
  ]);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(
    state.readers.length,
    1,
    "next batch must not start during the upload",
  );
  release();
  await rejection;
  await second;
  assert.deepEqual(
    calls.map(([url, type]) => [url, type]),
    [
      [encoded("one.png"), "image/jpeg"],
      [encoded("two.png"), "image/jpeg"],
      [encoded("three.png"), "image/jpeg"],
    ],
  );
  assert.ok(calls.every(([, , editor]) => editor === state.quill));
  assert.deepEqual(
    state.inserts,
    [],
    "custom uploads replace default insertion",
  );
});

test("direct fileChanged rejects for the caller rather than reporting an event error", async (t) => {
  const failure = new Error("programmer handles this");
  const errors = [];
  const state = setup(t, {
    insertIntoEditor() {
      throw failure;
    },
    onError: (error) => errors.push(error),
  });
  await assert.rejects(
    state.compressor.fileChanged([file()]),
    (error) => error === failure,
  );
  assert.deepEqual(errors, []);
});

test("toolbar reports async failures once even when onError itself throws", async (t) => {
  const failure = new Error("upload rejected");
  const errors = [];
  const state = setup(t, {
    insertIntoEditor: () => Promise.reject(failure),
    onError(error) {
      errors.push(error);
      throw new Error("reporting failed");
    },
  });
  state.handlers.image();
  const input = document.querySelector("input[type=file]");
  Object.defineProperty(input, "files", { value: [file()] });
  input.dispatchEvent(new dom.window.Event("change"));
  await Promise.allSettled(state.operations);
  await flush();
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(state.inserts, []);
});

test("event failures without an optional onError callback do not become unhandled rejections", async (t) => {
  const state = setup(t, {
    insertIntoEditor() {
      throw new Error("upload failed");
    },
  });
  for (const type of ["paste", "drop"]) {
    dispatch(state.root, type, { files: [file()] });
  }
  await Promise.allSettled(state.operations);
  await flush();
  assert.equal(state.operations.length, 2);
  assert.deepEqual(state.inserts, []);
});

for (const type of ["paste", "drop"]) {
  test(`${type} captures image files before built-in bubble handlers and retains the event selection`, async (t) => {
    const state = setup(t, {}, { manual: true });
    let builtIn = 0;
    state.root.addEventListener(type, () => {
      builtIn++;
    });
    const event = dispatch(state.root, type, { files: [file()] });
    assert.equal(event.defaultPrevented, true);
    assert.equal(builtIn, 0);
    state.move({ index: 19, length: 0 });
    await flush();
    state.readers[0].complete();
    await flush();
    state.images[0].complete();
    await state.operations[0];
    assert.equal(state.inserts[0][0], 3);
  });

  test(`${type} leaves text and nonimage files to existing handlers`, async (t) => {
    const state = setup(t);
    let bubbles = 0;
    state.root.addEventListener(type, () => {
      bubbles++;
    });
    for (const data of [
      { text: "plain text" },
      { files: [file("notes.txt", "text/plain")] },
    ]) {
      assert.equal(dispatch(state.root, type, data).defaultPrevented, false);
    }
    await flush();
    assert.equal(bubbles, 2);
    assert.equal(state.readers.length, 0);
    assert.deepEqual(state.inserts, []);
  });

  test(`${type} reports rejected insertions once and contains a throwing onError`, async (t) => {
    const failure = new Error(`${type} upload failed`);
    const errors = [];
    const state = setup(t, {
      insertIntoEditor() {
        throw failure;
      },
      onError(error) {
        errors.push(error);
        throw new Error("reporting failed");
      },
    });
    dispatch(state.root, type, { files: [file()] });
    await Promise.allSettled(state.operations);
    await flush();
    assert.deepEqual(errors, [failure]);
  });

  test(`real Quill 2 ${type} inserts exactly one compressed image without its built-in uploader reading it`, async (t) => {
    const mocks = media(t);
    const container = document.createElement("div");
    document.body.append(container);
    const quill = new Quill(container, { modules: { toolbar: false } });
    quill.setText("hello");
    // jsdom has no layout, but Quill scrolls the API selection after insertion.
    t.mock.method(quill, "scrollSelectionIntoView", () => {});
    quill.setSelection(2, 0, "silent");
    const caret = document.createRange();
    caret.setStart(quill.root.firstChild.firstChild, 2);
    caret.collapse(true);
    Object.defineProperty(document, "caretRangeFromPoint", {
      configurable: true,
      value: () => caret,
    });
    t.after(() => {
      delete document.caretRangeFromPoint;
      container.remove();
    });
    const compressor = new ImageCompressor(quill, {
      suppressErrorLogging: true,
    });
    t.after(() => compressor.destroy());
    const operations = track(t, compressor);
    const upload = t.mock.method(quill.uploader, "upload");
    assert.equal(
      dispatch(quill.root, type, { files: [file()] }).defaultPrevented,
      true,
    );
    await Promise.all(operations);
    await flush();
    assert.equal(operations.length, 1);
    assert.equal(upload.mock.callCount(), 0);
    assert.equal(mocks.readers.length, 1);
    assert.equal(mocks.images.length, 1);
    assert.deepEqual(quill.getContents().ops, [
      { insert: "he" },
      { insert: { image: encoded("first.png") } },
      { insert: "llo\n" },
    ]);
    assert.equal(quill.root.querySelectorAll("img").length, 1);
  });
}

test("clipboard item fallback accepts images and ignores null or nonimage items", async (t) => {
  const state = setup(t);
  const image = file();
  dispatch(state.root, "paste", {
    items: [
      {
        kind: "string",
        getAsFile() {
          throw new Error("not a file");
        },
      },
      { kind: "file", getAsFile: () => null },
      { kind: "file", getAsFile: () => file("notes.txt", "text/plain") },
      { kind: "file", getAsFile: () => image },
    ],
  });
  await Promise.all(state.operations);
  assert.deepEqual(
    state.readers.map((reader) => reader.file),
    [image],
  );
  assert.equal(state.inserts.length, 1);
});

test("local drags are unchanged and dragend re-enables external image drops", async (t) => {
  const state = setup(t);
  state.root.dispatchEvent(new dom.window.Event("dragstart"));
  assert.equal(
    dispatch(state.root, "drop", { files: [file()] }).defaultPrevented,
    false,
  );
  assert.equal(state.operations.length, 0);
  state.root.dispatchEvent(new dom.window.Event("dragend"));
  assert.equal(
    dispatch(state.root, "drop", { files: [file()] }).defaultPrevented,
    true,
  );
  await Promise.all(state.operations);
  assert.equal(state.inserts.length, 1);
});

test("handleOnPaste false leaves image paste alone without disabling image drops", async (t) => {
  const state = setup(t, { handleOnPaste: false });
  assert.equal(
    dispatch(state.root, "paste", { files: [file()] }).defaultPrevented,
    false,
  );
  assert.equal(state.operations.length, 0);
  dispatch(state.root, "drop", { files: [file()] });
  await Promise.all(state.operations);
  assert.equal(state.inserts.length, 1);
});

test("remote URL drops preserve selection while fetch is pending", async (t) => {
  let resolveFetch;
  const response = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const fetches = [];
  replaceGlobal(
    "fetch",
    (url) => {
      fetches.push(url);
      return response;
    },
    (fn) => t.after(fn),
  );
  const state = setup(t);
  assert.equal(
    dispatch(state.root, "drop", { url: "https://example.test/image.png" })
      .defaultPrevented,
    true,
  );
  state.move({ index: 17, length: 0 });
  resolveFetch({ ok: true, blob: async () => file("remote.png") });
  await flush();
  await Promise.all(state.operations);
  assert.deepEqual(fetches, ["https://example.test/image.png"]);
  assert.deepEqual(state.inserts, [
    [3, "image", encoded("remote.png"), "user"],
  ]);
});

test("failed HTTP and nonimage URL drops report onError once without inserting", async (t) => {
  for (const response of [
    { ok: false, status: 404 },
    { ok: true, blob: async () => file("page.html", "text/html") },
  ]) {
    await t.test(
      response.ok ? "nonimage response" : "HTTP failure",
      async (t) => {
        replaceGlobal(
          "fetch",
          async () => response,
          (fn) => t.after(fn),
        );
        const errors = [];
        const state = setup(t, { onError: (error) => errors.push(error) });
        dispatch(state.root, "drop", { url: "https://example.test/image.png" });
        await flush();
        assert.equal(errors.length, 1);
        assert.match(
          errors[0].message,
          response.ok ? /did not return an image/ : /404/,
        );
        assert.equal(
          state.operations.length,
          1,
          "failed remote drops still reserve a queue slot",
        );
        assert.equal(state.readers.length, 0);
        assert.deepEqual(state.inserts, []);
      },
    );
  }
});

test("destroy removes interception and any pending toolbar chooser", async (t) => {
  const state = setup(t);
  state.handlers.image();
  state.compressor.destroy();
  assert.equal(document.querySelector("input[type=file]"), null);
  for (const type of ["paste", "drop"]) {
    assert.equal(
      dispatch(state.root, type, { files: [file()] }).defaultPrevented,
      false,
    );
  }
  await flush();
  assert.equal(state.operations.length, 0);
});
