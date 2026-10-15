import assert from "node:assert/strict";
import { after, test } from "node:test";
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
  "Node",
  "Text",
  "MutationObserver",
]) {
  replaceGlobal(name, dom.window[name], after);
}
after(() => dom.window.close());
const { default: ImageCompressor } = await import("../dist/index.js");
const source = "data:image/png;base64,aGVsbG8=";
const output = "data:image/jpeg;base64,aGVsbG8=";

function setup(t, options = {}, behavior = {}) {
  const images = [];
  const draws = [];
  const fills = [];
  const exports = [];
  const inserts = [];
  const selections = [];
  const context = {
    fillRect: (...args) => fills.push(args),
    drawImage: (...args) => draws.push(args),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => (behavior.noContext ? null : context),
    toDataURL: (...args) => {
      exports.push(args);
      if (behavior.exportError) throw behavior.exportError;
      return behavior.output ?? output;
    },
  };
  replaceGlobal(
    "Image",
    class {
      naturalWidth = behavior.width ?? 1000;
      naturalHeight = behavior.height ?? 800;
      constructor() {
        images.push(this);
      }
      set src(value) {
        assert.equal(
          typeof this.onload,
          "function",
          "load handler must precede src",
        );
        assert.equal(
          typeof this.onerror,
          "function",
          "error handler must precede src",
        );
        this.url = value;
        if (behavior.decodeError) this.onerror();
        else this.onload();
      }
    },
    (fn) => t.after(fn),
  );
  const createElement = document.createElement.bind(document);
  t.mock.method(document, "createElement", (tag, ...args) =>
    tag === "canvas" ? canvas : createElement(tag, ...args),
  );
  const quill = {
    on() {},
    off() {},
    deleteText() {},
    root: document.createElement("div"),
    getModule: () => ({ addHandler() {} }),
    getSelection: () => ({ index: 0, length: 0 }),
    insertEmbed: (...args) => inserts.push(args),
    setSelection: (...args) => selections.push(args),
  };
  const compressor = new ImageCompressor(quill, options);
  return {
    compressor,
    canvas,
    context,
    images,
    draws,
    fills,
    exports,
    inserts,
    selections,
  };
}

test("fits both 500px bounds, preserves aspect ratio, and never upscales", async (t) => {
  const cases = [
    [1000, 800, { maxWidth: 500, maxHeight: 500 }, [500, 400]],
    [800, 1000, { maxWidth: 500, maxHeight: 500 }, [400, 500]],
    [300, 200, { maxWidth: 500, maxHeight: 500 }, [300, 200]],
    [1000, 800, { maxHeight: 500 }, [625, 500]],
    [1000, 800, { maxWidth: 500 }, [500, 400]],
    [1000, 800, {}, [1000, 800]],
    [10000, 1, { maxWidth: 500, maxHeight: 500 }, [500, 1]],
    [1, 10000, { maxWidth: 500, maxHeight: 500 }, [1, 500]],
    [1200, 801, { maxWidth: 500, maxHeight: 500 }, [500, 333]],
  ];
  for (const [width, height, options, expected] of cases) {
    await t.test(`${width}x${height} ${JSON.stringify(options)}`, async (t) => {
      const state = setup(t, options, { width, height });
      assert.equal(
        await state.compressor.downscaleImageFromUrl(source),
        output,
      );
      assert.deepEqual([state.canvas.width, state.canvas.height], expected);
      assert.deepEqual(state.draws[0].slice(1), [0, 0, ...expected]);
      assert.equal(state.images[0].onload, null);
      assert.equal(state.images[0].onerror, null);
    });
  }
});

test("honors quality zero and fills only the output-sized JPEG background", async (t) => {
  const state = setup(t, { quality: 0, maxWidth: 500, maxHeight: 500 });
  await state.compressor.downscaleImageFromUrl(source);
  assert.deepEqual(state.exports, [["image/jpeg", 0]]);
  assert.equal(state.context.fillStyle, "#FFFFFF");
  assert.deepEqual(state.fills, [[0, 0, 500, 400]]);
});

test("uses default quality when omitted", async (t) => {
  const state = setup(t);
  await state.compressor.downscaleImageFromUrl(source);
  assert.deepEqual(state.exports, [["image/jpeg", 0.7]]);
});

test("keeps PNG MIME before deciding whether to paint a JPEG background", async (t) => {
  const state = setup(t, { keepImageTypes: ["image/png"] });
  await state.compressor.downscaleImageFromUrl(source);
  assert.deepEqual(state.exports, [["image/png", 0.7]]);
  assert.deepEqual(state.fills, []);
});

test("ignored image types return unchanged without decoding or creating a canvas", async (t) => {
  const state = setup(t, {
    ignoreImageTypes: ["image/png"],
    keepImageTypes: ["image/png"],
  });
  assert.equal(await state.compressor.downscaleImageFromUrl(source), source);
  assert.deepEqual(state.images, []);
  assert.deepEqual(state.exports, []);
  assert.equal(state.canvas.width, 0);
});

test("corrupt image decoding rejects and clears handlers", async (t) => {
  const state = setup(t, {}, { decodeError: true });
  await assert.rejects(
    state.compressor.downscaleImageFromUrl("data:image/png;base64,broken"),
    /decode/i,
  );
  assert.equal(state.images[0].onload, null);
  assert.equal(state.images[0].onerror, null);
  assert.deepEqual(state.draws, []);
});

test("invalid decoded dimensions reject", async (t) => {
  for (const value of [0, -1, NaN, Infinity]) {
    for (const key of ["width", "height"]) {
      await t.test(`${key}=${value}`, async (t) => {
        const state = setup(t, {}, { [key]: value });
        await assert.rejects(
          state.compressor.downscaleImageFromUrl(source),
          /positive finite/,
        );
        assert.deepEqual(state.draws, []);
      });
    }
  }
});

test("missing canvas context and failed exports reject", async (t) => {
  const cases = [
    [{ noContext: true }, /context/],
    [{ exportError: new Error("tainted canvas") }, /tainted canvas/],
    [{ output: "data:," }, /export/],
    [{ output: "" }, /export/],
  ];
  for (const [behavior, expected] of cases) {
    await t.test(JSON.stringify(behavior), async (t) => {
      const state = setup(t, {}, behavior);
      await assert.rejects(
        state.compressor.downscaleImageFromUrl(source),
        expected,
      );
    });
  }
});

function stubReader(t, behavior = {}) {
  const readers = [];
  replaceGlobal(
    "FileReader",
    class {
      listeners = new Map();
      result = behavior.result === undefined ? source : behavior.result;
      error = behavior.error ?? null;
      constructor() {
        readers.push(this);
      }
      addEventListener(name, handler) {
        this.listeners.set(name, handler);
      }
      removeEventListener(name, handler) {
        assert.equal(this.listeners.get(name), handler);
        this.listeners.delete(name);
      }
      readAsDataURL(file) {
        this.file = file;
        assert.equal(this.listeners.size, 3);
        if (behavior.throw) throw behavior.throw;
        this.listeners.get(behavior.event ?? "load")();
      }
    },
    (fn) => t.after(fn),
  );
  return readers;
}

test("fileChanged reads, compresses, and inserts the file, then cleans up listeners", async (t) => {
  const state = setup(t);
  const readers = stubReader(t);
  const file = new dom.window.File(["hello"], "image.png", {
    type: "image/png",
  });
  await state.compressor.fileChanged([file]);
  assert.equal(readers[0].file, file);
  assert.equal(readers[0].listeners.size, 0);
  assert.deepEqual(state.inserts, [[0, "image", output, "user"]]);
  assert.deepEqual(state.selections, [[{ index: 1, length: 0 }, "api"]]);
});

test("fileChanged propagates read failures and aborts without inserting", async (t) => {
  const failure = new Error("disk read failed");
  const cases = [
    [{ event: "error", error: failure }, failure],
    [{ event: "error" }, /read file/i],
    [{ event: "abort" }, /aborted/i],
    [{ result: null }, /convert file/i],
    [{ result: "" }, /convert file/i],
    [{ result: new ArrayBuffer(1) }, /convert file/i],
    [{ throw: failure }, failure],
  ];
  for (const [behavior, expected] of cases) {
    await t.test(JSON.stringify(behavior), async (t) => {
      const state = setup(t);
      const readers = stubReader(t, behavior);
      await assert.rejects(
        state.compressor.fileChanged([new dom.window.File([], "image.png")]),
        expected,
      );
      assert.equal(readers[0].listeners.size, 0);
      assert.deepEqual(state.images, []);
      assert.deepEqual(state.inserts, []);
    });
  }
});

test("fileChanged propagates image conversion failures without inserting", async (t) => {
  const state = setup(t, {}, { decodeError: true });
  const readers = stubReader(t);
  await assert.rejects(
    state.compressor.fileChanged([new dom.window.File([], "image.png")]),
    /decode/i,
  );
  assert.equal(readers[0].listeners.size, 0);
  assert.deepEqual(state.inserts, []);
});
