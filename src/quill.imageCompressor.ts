import type Quill from "quill";
import type { Range, Delta } from "quill";
import type Toolbar from "quill/modules/toolbar";
import { ImageDrop } from "./quill.imageDrop.js";
import { warnAboutOptions } from "./options.validation.js";
import { file2b64 } from "./file2b64.js";
import { downscaleImage } from "./downscaleImage.js";
import { ConsoleLogger } from "./ConsoleLogger.js";
import type { OptionsObject } from "./options.object.js";

class imageCompressor {
  private range?: Range;
  private readonly options: OptionsObject;
  private readonly imageDrop: ImageDrop;
  private fileHolder?: HTMLInputElement;
  private readonly Logger: ConsoleLogger;
  private pending: Promise<void> = Promise.resolve();
  private destroyed = false;
  private readonly anchors = new Set<Range>();
  private readonly selectionChanged = (range: Range | null): void => {
    if (range) this.range = { ...range };
  };
  private readonly textChanged = (delta: Delta): void => {
    // Formatters may emit numeric text-change notifications without a document delta.
    if (typeof delta?.transformPosition !== "function") return;
    const ranges = this.range
      ? [this.range, ...this.anchors]
      : [...this.anchors];
    for (const range of ranges) {
      const end = delta.transformPosition(range.index + range.length, true);
      // Later batches at the same cursor follow earlier insertions.
      range.index = delta.transformPosition(range.index, false);
      range.length = Math.max(0, end - range.index);
    }
  };

  static b64toBlob(dataURI: string): Blob {
    const byteString = atob(dataURI.split(",")[1]);
    const type = dataURI.slice(5).split(";")[0];
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++)
      bytes[i] = byteString.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  constructor(
    private readonly quill: Quill,
    options: OptionsObject = {},
  ) {
    this.options = { ...options };
    this.Logger = new ConsoleLogger(
      !!options.debug,
      !!options.suppressErrorLogging,
    );
    warnAboutOptions(this.options, this.Logger);
    quill.on("selection-change", this.selectionChanged);
    quill.on("text-change", this.textChanged);
    this.imageDrop = new ImageDrop(
      quill,
      (files, range) => this.fileChanged(files, range),
      () => this.captureRange(),
      (error) => this.reportError(error),
      this.options.handleOnPaste !== false,
    );
    const toolbar = quill.getModule("toolbar") as Toolbar | undefined;
    if (toolbar) toolbar.addHandler("image", () => this.selectLocalImage());
  }

  private captureRange(): Range {
    const selection = this.quill.getSelection();
    this.range = selection
      ? { index: selection.index, length: selection.length }
      : (this.range ?? {
          index: Math.max(0, this.quill.getLength() - 1),
          length: 0,
        });
    return { ...this.range };
  }

  private reportError(error: unknown): void {
    if (this.destroyed) return;
    this.Logger.error(error);
    try {
      this.options.onError?.(error);
    } catch (callbackError) {
      this.Logger.error(callbackError);
    }
  }

  selectLocalImage(onFileChanged?: () => void): void {
    if (this.destroyed) return;
    const range = this.captureRange();
    const input = document.createElement("input");
    this.fileHolder = input;
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    const remove = () => {
      input.remove();
      if (this.fileHolder === input) this.fileHolder = undefined;
    };
    input.addEventListener(
      "change",
      () => {
        const files = Array.from(input.files ?? []);
        remove();
        void this.fileChanged(files, range)
          .then(() => {
            if (!this.destroyed) onFileChanged?.();
          })
          .catch((error) => this.reportError(error));
      },
      { once: true },
    );
    input.addEventListener("cancel", remove, { once: true });
    document.body.appendChild(input);
    try {
      input.click();
    } catch (error) {
      remove();
      this.reportError(error);
    }
  }

  fileChanged(
    externallyProvidedFiles?: Blob[] | (() => Promise<Blob[]>),
    insertionRange?: Range,
  ): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const source =
      typeof externallyProvidedFiles === "function"
        ? externallyProvidedFiles
        : Array.from(externallyProvidedFiles ?? this.fileHolder?.files ?? []);
    const range = insertionRange ? { ...insertionRange } : this.captureRange();
    this.anchors.add(range);
    // Keep each batch in event order, and retain its selection across asynchronous work.
    const operation = this.pending
      .then(async () => {
        if (this.destroyed) return;
        const files = typeof source === "function" ? await source() : source;
        if (this.destroyed) return;
        for (const file of files) {
          if (this.destroyed) return;
          const dataUrl = await file2b64(file);
          if (this.destroyed) return;
          const compressed = await this.downscaleImageFromUrl(dataUrl);
          if (this.destroyed) return;
          await this.insertToEditor(
            compressed,
            imageCompressor.b64toBlob(compressed),
            range,
          );
          if (this.destroyed) return;
        }
      })
      .finally(() => {
        this.anchors.delete(range);
      });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async downscaleImageFromUrl(dataUrl: string): Promise<string> {
    return downscaleImage(
      this.Logger,
      dataUrl,
      this.options.maxWidth,
      this.options.maxHeight,
      this.options.imageType,
      this.options.keepImageTypes,
      this.options.ignoreImageTypes,
      this.options.quality,
    );
  }

  async insertToEditor(
    url: string,
    blob: Blob,
    range = this.captureRange(),
  ): Promise<void> {
    if (this.destroyed) return;
    if (this.options.insertIntoEditor) {
      // A callback already started owns its side effects and cannot be canceled here.
      await this.options.insertIntoEditor(url, blob, this.quill);
      return;
    }
    const tracked = this.anchors.delete(range);
    try {
      if (range.length) {
        this.quill.deleteText(range.index, range.length, "user");
        range.length = 0;
      }
      if (this.destroyed) return;
      this.quill.insertEmbed(range.index, "image", url, "user");
      range.index++;
      if (this.destroyed) return;
      this.quill.setSelection({ index: range.index, length: 0 }, "api");
    } finally {
      if (tracked && !this.destroyed) this.anchors.add(range);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.anchors.clear();
    this.quill.off("selection-change", this.selectionChanged);
    this.quill.off("text-change", this.textChanged);
    this.imageDrop.destroy();
    this.fileHolder?.remove();
    this.fileHolder = undefined;
  }
}

export { imageCompressor };
export default imageCompressor;
