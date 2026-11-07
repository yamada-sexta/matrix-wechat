import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaWatch } from "../src/media-watch";

test("cache watchers follow new directories and ignore partial files until verification succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "wechat-cache-watch-")),
    watcher = new MediaWatch();
  const directory = join(root, "chat", "month", "Img"),
    file = join(directory, "image.dat");
  let ready = 0;
  const complete = new Promise<void>((resolve) =>
    watcher.watch(
      "image",
      root,
      [directory],
      async () => (await readFile(file, "utf8")) === "verified-original",
      () => {
        ready++;
        resolve();
      },
    ),
  );
  try {
    await Bun.sleep(150);
    await mkdir(directory, { recursive: true });
    await writeFile(file, "partial");
    await Bun.sleep(250);
    expect(ready).toBe(0);
    await writeFile(file, "verified-original");
    await Promise.race([
      complete,
      Bun.sleep(3000).then(() => {
        throw Error("File arrival did not wake media");
      }),
    ]);
    expect(ready).toBe(1);
    await writeFile(file, "verified-original");
    await Bun.sleep(150);
    expect(ready).toBe(1);
  } finally {
    watcher.clear();
    await rm(root, { recursive: true, force: true });
  }
});
test("clearing watchers on an account change suppresses stale in-flight completions", async () => {
  const root = await mkdtemp(join(tmpdir(), "wechat-cache-account-")),
    watcher = new MediaWatch();
  let finish: () => void = () => {},
    started: () => void = () => {},
    ready = 0;
  const probing = new Promise<void>((resolve) => {
    started = resolve;
  });
  watcher.watch(
    "old-account",
    root,
    [root],
    async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return true;
    },
    () => {
      ready++;
    },
  );
  try {
    await probing;
    watcher.clear();
    finish();
    await Bun.sleep(50);
    expect(ready).toBe(0);
  } finally {
    watcher.clear();
    await rm(root, { recursive: true, force: true });
  }
});
