import type { ConsoleLogger } from "./ConsoleLogger.js";

// Take an image URL, downscale it to the given width, and return a new image URL.
export async function downscaleImage(
  logger: ConsoleLogger,
  dataUrl: string,
  maxWidth?: number,
  maxHeight?: number,
  imageType?: string,
  keepImageTypes?: string[],
  ignoreImageTypes?: string[],
  imageQuality?: number,
) {
  "use strict";
  // Input image values
  const inputImageType = dataUrl.split(";")[0].split(":")[1];

  // Provide default values
  imageType = imageType || "image/jpeg";
  imageQuality = imageQuality ?? 0.7;

  if (ignoreImageTypes?.includes(inputImageType)) {
    return dataUrl;
  }
  if (keepImageTypes?.includes(inputImageType)) {
    imageType = inputImageType;
  }

  // Create a temporary image so that we can compute the height of the downscaled image.
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("Could not decode image"));
    };
    try {
      image.src = dataUrl;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
  const [newWidth, newHeight] = getDimensions(
    image.naturalWidth,
    image.naturalHeight,
    maxWidth,
    maxHeight,
  );

  // Create a temporary canvas to draw the downscaled image on.
  const canvas = document.createElement("canvas");
  canvas.width = newWidth;
  canvas.height = newHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not create canvas context");
  }

  // If the type is an jpeg, draw a white background first.
  if (imageType === "image/jpeg") {
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, newWidth, newHeight);
  }

  // Draw the downscaled image on the canvas and return the new data URL.
  ctx.drawImage(image, 0, 0, newWidth, newHeight);
  const newDataUrl = canvas.toDataURL(imageType, imageQuality);
  if (!/^data:image\/[^,]+,.+/.test(newDataUrl)) {
    throw new Error("Could not export canvas image");
  }
  logger.log("downscaling image...", {
    args: {
      dataUrl,
      maxWidth,
      maxHeight,
      imageType,
      ignoreImageTypes,
      keepImageTypes,
      imageQuality,
    },
    newHeight,
    newWidth,
  });
  return newDataUrl;
}

function getDimensions(
  inputWidth: number,
  inputHeight: number,
  maxWidth?: number,
  maxHeight?: number,
): [number, number] {
  if (
    ![inputWidth, inputHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    [maxWidth, maxHeight].some(
      (value) => value !== undefined && (!Number.isFinite(value) || value <= 0),
    )
  ) {
    throw new Error(
      "Image dimensions and limits must be positive finite numbers",
    );
  }
  const scale = Math.min(
    1,
    (maxWidth ?? inputWidth) / inputWidth,
    (maxHeight ?? inputHeight) / inputHeight,
  );
  return [
    Math.max(1, Math.floor(inputWidth * scale)),
    Math.max(1, Math.floor(inputHeight * scale)),
  ];
}
