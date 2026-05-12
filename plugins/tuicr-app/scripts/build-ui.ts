import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = resolve(ROOT, "dist");

const result = await esbuild.build({
  entryPoints: [resolve(ROOT, "src", "ui", "main.tsx")],
  bundle: true,
  format: "iife",
  outfile: resolve(outdir, "review-widget.js"),
  target: "es2020",
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  write: false,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

const js = result.outputFiles.find((file) => file.path.endsWith("review-widget.js"))?.text;
const css = await readFile(resolve(ROOT, "dist", "styles.css"), "utf8")
  .catch(() => readFile(resolve(ROOT, "src", "ui", "styles.css"), "utf8"));

if (!js) {
  throw new Error("React UI build did not produce JavaScript output");
}

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>tuicr review</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${js}</script>
  </body>
</html>
`;

await mkdir(outdir, { recursive: true });
await writeFile(resolve(outdir, "review-widget.html"), html);
