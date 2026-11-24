import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const outdir = path.resolve(".worker");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [
    path.resolve("src/server/worker/processor.ts"),
    path.resolve("src/server/worker/maintenance-child.ts"),
  ],
  outdir,
  bundle: true,
  splitting: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  conditions: ["react-server"],
  packages: "external",
  tsconfig: path.resolve("tsconfig.json"),
  logLevel: "error",
});
