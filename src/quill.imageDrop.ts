import type Quill from "quill";
import type { Range } from "quill";

function isImage(file: Blob): boolean {
  return /^image\/(gif|jpe?g|a?png|svg\+xml|webp|bmp)$/i.test(file.type);
}

export class ImageDrop {
  private localDrag = false;
  private destroyed = false;
  private readonly requests = new Set<AbortController>();

  constructor(
    private readonly quill: Quill,
    private readonly onImages: (
      files: Blob[] | (() => Promise<Blob[]>),
      range: Range,
    ) => Promise<void>,
    private readonly getRange: () => Range,
    private readonly onError: (error: unknown) => void,
    private readonly handleOnPaste = true,
  ) {
    quill.root.addEventListener("dragstart", this.handleDragStart);
    quill.root.addEventListener("dragend", this.handleDragEnd);
    quill.root.addEventListener("drop", this.handleDrop, true);
    if (handleOnPaste)
      quill.root.addEventListener("paste", this.handlePaste, true);
  }

  private handleDragStart = (): void => {
    this.localDrag = true;
  };
  private handleDragEnd = (): void => {
    this.localDrag = false;
  };

  private getFiles(data: DataTransfer): Blob[] {
    const files = Array.from(data.files ?? []).filter(isImage);
    if (files.length) return files;
    return Array.from(data.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file != null && isImage(file));
  }

  private handleDrop = (event: DragEvent): void => {
    if (this.destroyed || this.localDrag || !event.dataTransfer) return;
    const files = this.getFiles(event.dataTransfer);
    const data = event.dataTransfer;
    const url = (
      data.getData("URL") ||
      data
        .getData("text/uri-list")
        .split(/\r?\n/)
        .find((line) => line.trim() && !line.startsWith("#")) ||
      data.getData("text/plain")
    ).trim();
    if (!files.length && !url) return;
    const doc = this.quill.root.ownerDocument;
    if (!files.length) {
      let imageUrl = /^data:image\//i.test(url);
      try {
        const parsed = new URL(url, doc.baseURI);
        imageUrl ||= /\.(gif|jpe?g|a?png|svg|webp|bmp|avif|ico)$/i.test(
          parsed.pathname,
        );
        if (!imageUrl) {
          const html = new DOMParser().parseFromString(
            data.getData("text/html"),
            "text/html",
          );
          imageUrl = Array.from(html.querySelectorAll("img[src]")).some(
            (image) =>
              new URL(image.getAttribute("src")!, doc.baseURI).href ===
              parsed.href,
          );
        }
      } catch {
        /* An unrecognized URL belongs to the native drop handlers. */
      }
      if (!imageUrl) return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    // Quill 2's built-in uploader must not insert a second, uncompressed image.
    let caret = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (!caret) {
      const position = (
        doc as Document & {
          caretPositionFromPoint?: (
            x: number,
            y: number,
          ) => { offsetNode: Node; offset: number } | null;
        }
      ).caretPositionFromPoint?.(event.clientX, event.clientY);
      if (position) {
        caret = doc.createRange();
        caret.setStart(position.offsetNode, position.offset);
        caret.collapse(true);
      }
    }
    const selection = doc.getSelection();
    if (caret && selection) {
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    // getSelection synchronously updates Quill's cached selection from the native caret.
    const current = this.quill.getSelection();
    const range = current
      ? { index: current.index, length: current.length }
      : this.getRange();
    const upload = files.length
      ? this.onImages(files, range)
      : this.onImages(async () => {
          if (this.destroyed) return [];
          const controller = new AbortController();
          this.requests.add(controller);
          try {
            const response = await fetch(url, { signal: controller.signal });
            if (this.destroyed) return [];
            if (!response.ok)
              throw new Error(`Unable to fetch image: ${response.status}`);
            const image = await response.blob();
            if (this.destroyed) return [];
            if (!isImage(image))
              throw new Error("Dropped URL did not return an image");
            return [image];
          } finally {
            this.requests.delete(controller);
          }
        }, range);
    void upload.catch((error) => {
      if (!this.destroyed) this.onError(error);
    });
  };

  private handlePaste = (event: ClipboardEvent): void => {
    if (this.destroyed || !event.clipboardData) return;
    const files = this.getFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void this.onImages(files, this.getRange()).catch((error) => {
      if (!this.destroyed) this.onError(error);
    });
  };

  destroy(): void {
    this.destroyed = true;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.quill.root.removeEventListener("dragstart", this.handleDragStart);
    this.quill.root.removeEventListener("dragend", this.handleDragEnd);
    this.quill.root.removeEventListener("drop", this.handleDrop, true);
    if (this.handleOnPaste)
      this.quill.root.removeEventListener("paste", this.handlePaste, true);
  }
}
