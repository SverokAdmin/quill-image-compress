# quill-image-compress

This fork of the Quill image compression module targets **Quill 2.0.3 and later
compatible 2.x releases**. Version 2.0.0 is Quill 2-only; it does not support Quill 1.
It compresses images selected from the toolbar, dropped into the editor, or pasted.
You do not need a separate image-drop module.

## Install

This fork is not yet published as version 2.0.0. Once the changes are committed
and available remotely, install an immutable commit rather than a moving branch:

```sh
npm install quill@2.0.3 'git+https://github.com/SverokAdmin/quill-image-compress.git#<full-commit-sha>'
```

Replace `<full-commit-sha>` with the reviewed fork commit. The Git installation's
`prepare` script builds the package with its development dependencies. For local
development, run `npm install --strict-peer-deps` in this repository instead.

## ESM Usage

```js
import Quill from 'quill';
import ImageCompress from '@sverokadmin/quill-image-compress';
// Equivalent named import: import { imageCompressor } from '@sverokadmin/quill-image-compress';
import 'quill/dist/quill.snow.css';

Quill.register('modules/imageCompress', ImageCompress);

const quill = new Quill('#editor', {
  theme: 'snow',
  modules: {
    toolbar: [['bold', 'italic', 'image']],
    imageCompress: {
      quality: 0.7,
      maxWidth: 1000,
      maxHeight: 1000,
      imageType: 'image/jpeg',
      handleOnPaste: true,
      onError: (error) => console.error('Image processing failed', error),
    },
  },
});
```

Import from the package root, not internal source paths. The ESM entry is
`dist/index.js`; the CommonJS entry is `dist/index.cjs`:

```js
const { imageCompressor } = require('@sverokadmin/quill-image-compress');
```

Both entries expose the same constructor as a default export and as
`imageCompressor`. They do not import Quill at runtime or create a browser global.
Quill must still be provided by the consuming application, and constructing an
editor or processing images requires a browser DOM and canvas APIs.

TypeScript declarations are included in `dist/types`. The package exports the
`ImageCompressorOptions` type:

```ts
import type { ImageCompressorOptions } from '@sverokadmin/quill-image-compress';
```

## Script Tags

The browser artifact retains the existing path and **constructor** global
`imageCompressor`, not a module namespace. Copy the built artifact into your
application's public assets; this example does not assume an unpublished CDN release.

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.snow.css">
<div id="editor"></div>
<script src="https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.js"></script>
<script src="./dist/quill.imageCompressor.min.js"></script>
<script>
  Quill.register('modules/imageCompress', imageCompressor);
  const quill = new Quill('#editor', {
    theme: 'snow',
    modules: {
      toolbar: [['image']],
      imageCompress: { quality: 0.7, handleOnPaste: true },
    },
  });
</script>
```

Only this IIFE build defines the global. The module source does not write to `window`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `maxWidth` | `1000` | Maximum output width in pixels. |
| `maxHeight` | `1000` | Maximum output height in pixels. |
| `quality` | `0.7` | Encoder quality from 0 to 1, where supported by the output format. |
| `imageType` | `'image/jpeg'` | Requested output MIME type, subject to browser canvas support. |
| `keepImageTypes` | `[]` | MIME types to preserve while still applying dimensions and quality. |
| `ignoreImageTypes` | `[]` | MIME types to leave unchanged, without compression or resizing. |
| `handleOnPaste` | `true` | Handle pasted image files; set to `false` to leave paste to Quill. |
| `debug` | `false` | Enable diagnostic logging. |
| `suppressErrorLogging` | `false` | Suppress the module's console error logging. |
| `onError` | unset | Receive image-processing errors through a callback. |
| `insertIntoEditor` | unset | Override insertion with `(base64URL, imageBlob, editor)`. |

Browser-supported input formats can be decoded and compressed. Canvas conversion
may flatten animated images; use `ignoreImageTypes` when originals must be retained.
The built-in insertion preserves the cursor position captured before asynchronous
image processing rather than querying a potentially changed selection afterward.
Custom `insertIntoEditor` callbacks own their insertion and cursor behavior.

Uploads are serialized in event order. Pending insertion positions follow editor
changes, and inserting over a selection replaces that selection once per batch.
Ordinary link drops are left to Quill; remote image URLs must be recognizable by
their image extension, a `data:image` URL, or accompanying HTML image markup.

When disposing an editor, call its module's `destroy()` method to remove listeners,
abort remote fetches, and prevent pending work from inserting into the old editor:

```js
quill.getModule('imageCompress').destroy();
```

Quill does not call this method automatically. An already-started custom
`insertIntoEditor` callback owns its side effects and cannot be undone by the module.

For example, upload the compressed blob instead of embedding base64:

```js
const options = {
  insertIntoEditor: async (_base64URL, imageBlob, editor) => {
    const index = editor.getSelection()?.index ?? editor.getLength() - 1;
    const body = new FormData();
    body.append('file', imageBlob);
    const response = await fetch('/upload', { method: 'POST', body });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    const url = await response.text();
    editor.insertEmbed(index, 'image', url, 'user');
    editor.setSelection(index + 1, 0, 'silent');
  },
  onError: (error) => console.error(error),
};
```

## Development

Use Node.js 20 or newer and npm. Quill 2.0.3, TypeScript 5.5.4, and jsdom 26.1.0
are development dependencies; Quill's own types are used instead of `@types/quill`.

```sh
npm install --strict-peer-deps
npm run check
npm test
npm run build
npm pack --dry-run
```

`npm test` builds first, then runs `node --test test/*.test.mjs`.
`npm run build` cleans `dist`, emits declarations with TypeScript, and uses esbuild
to produce ESM, CommonJS, and a minified browser IIFE. The package includes only
these runtime artifacts, declarations, README, license, and package metadata,
not source, tests, or demos.

After building, serve the repository root with a static HTTP server and open
`src/demo.html` for the native ESM demo or `src/demo-script-tag.html` for the
constructor-global demo. Both use Quill 2.0.3 from jsDelivr and require network access.

## Thanks

Based on [quill-image-uploader](https://github.com/NoelOConnell/quill-image-uploader)
and the original [quill-image-compress](https://github.com/benwinding/quill-image-compress).
