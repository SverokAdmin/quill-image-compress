import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

process.chdir(fileURLToPath(new URL(".", import.meta.url)));
await rm("dist", { recursive: true, force: true });
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "--emitDeclarationOnly"],
  {
    stdio: "inherit",
  },
);

const shared = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  target: "es2020",
  external: ["quill"],
  logLevel: "info",
};

await Promise.all([
  build({ ...shared, format: "esm", outfile: "dist/index.js" }),
  build({ ...shared, format: "cjs", outfile: "dist/index.cjs" }),
  build({
    ...shared,
    format: "iife",
    globalName: "imageCompressor",
    minify: true,
    outfile: "dist/quill.imageCompressor.min.js",
    // Preserve the constructor global used by existing script-tag integrations.
    footer: { js: "imageCompressor = imageCompressor.default;" },
  }),
]);
