import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
const root = path.resolve();
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [path.join(root, "client/script.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  outfile: path.join(dist, "bundle.js"),
  legalComments: "eof",
  sourcemap: false,
});
await cp(path.join(root, "client/index.html"), path.join(dist, "index.html"));
await cp(path.join(root, "client/style.css"), path.join(dist, "style.css"));
console.log("Built dist/index.html, dist/style.css, and dist/bundle.js.");
