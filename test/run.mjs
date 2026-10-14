import esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, ".build", "sync.test.mjs");

await esbuild.build({
  entryPoints: [path.join(here, "sync.test.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  logLevel: "warning",
  alias: { obsidian: path.join(here, "obsidian-mock.mjs") },
});

await import(pathToFileURL(outfile).href);
