import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = resolve(ROOT, "dist");

await mkdir(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(ROOT, "src", "server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(outdir, "server.js"),
  sourcemap: false,
  packages: "external",
});
