import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await mkdir("dist/web", { recursive: true });
for (const [entry, outdir, target] of [
  [fileURLToPath(import.meta.resolve("wechat-native/instrument")), "dist/native", "browser"],
  ["src/web/app.tsx", "dist/web", "browser"],
] as const) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target,
    minify: false,
    naming: "[name].[ext]",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new AggregateError(result.logs, "Build failed");
}
await writeFile(
  "dist/web/index.html",
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>WeChat</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
);
