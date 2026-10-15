export async function file2b64(file: Blob) {
  const fileReader = new FileReader();

  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      fileReader.removeEventListener("load", onLoad);
      fileReader.removeEventListener("error", onError);
      fileReader.removeEventListener("abort", onAbort);
    };
    const onLoad = () => {
      cleanup();
      if (typeof fileReader.result !== "string" || !fileReader.result) {
        reject(new Error("Could not convert file to base64"));
      } else {
        resolve(fileReader.result);
      }
    };
    const onError = () => {
      cleanup();
      reject(fileReader.error ?? new Error("Could not read file"));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("File reading aborted"));
    };
    fileReader.addEventListener("load", onLoad);
    fileReader.addEventListener("error", onError);
    fileReader.addEventListener("abort", onAbort);
    try {
      fileReader.readAsDataURL(file);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
