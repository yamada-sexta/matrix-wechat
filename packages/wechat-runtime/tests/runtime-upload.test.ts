import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { Runtime } from "../src/runtime";
import type { Message } from "../src/types";

const directory = await mkdtemp(join(tmpdir(), "wechat-outbound-test-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

test("image queue acknowledgement retains upload sources until server confirmation", async () => {
  const runtime = new Runtime(directory);
  runtime.status = { state: "logged_in" };
  Object.assign(runtime, { sendReady: true });
  runtime.store.databases = async () => [
    {
      id: "fixture",
      path: join(directory, "account/db_storage/message.db"),
      readable: true,
      encrypted: true,
    },
  ];
  const bytes = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  let path = "";
  const messages: Message[] = [];
  runtime.native = async (method, _chat, source) => {
    expect(method).toBe("sendimage");
    path = source;
    expect((await readFile(path)).equals(bytes)).toBe(true);
    return { success: true };
  };
  runtime.store.history = async () => ({ messages, next_cursor: undefined });
  try {
    expect(await runtime.sendImage("fixture-self", bytes)).toEqual({
      success: true,
      acknowledgement: "native_handler",
    });
    const cachedPath = join(
      directory,
      "account/cache",
      new Date().toISOString().slice(0, 7),
      "HttpResource",
      createHash("md5").update(path).digest("hex"),
    );
    expect(existsSync(path)).toBe(true);
    expect(existsSync(cachedPath)).toBe(true);
    expect(runtime.verified.has("send.image")).toBe(false);
    messages.push({
      id: "123",
      account_id: "fixture-self",
      chat_id: "fixture-self",
      sender_id: "fixture-self",
      chat_type: "direct",
      kind: "image",
      timestamp: Date.now() / 1000,
      own: true,
      native: {
        decoded_content: `<msg><img md5="${createHash("md5").update(bytes).digest("hex")}"/></msg>`,
      },
    });
    await Bun.sleep(1200);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(cachedPath)).toBe(false);
    expect(runtime.verified.has("send.image")).toBe(true);
  } finally {
    runtime.stopped = true;
  }
});
