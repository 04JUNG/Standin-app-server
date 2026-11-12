import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("dist/replay", { recursive: true });
await build({
  entryPoints: ["src/replay/player.mjs"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  loader: { ".css": "text" },
  outfile: "dist/replay/player.bundle.js",
});
