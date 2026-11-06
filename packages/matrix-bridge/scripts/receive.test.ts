import { afterEach, expect, test } from "bun:test";
import { APIError } from "wechat-rpc";
import { WeChatBridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { messageFingerprint } from "../src/convert";
import type { Matrix } from "../src/matrix";
import type { Message } from "../src/messages";
import { type MatrixEvent, Store } from "../src/store";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture() {
  const config = await loadConfig(
    new URL("../../../example-config.yaml", import.meta.url).pathname,
  );
  const store = new Store(":memory:");
  stores.push(store);
  store.addPortal("self", "contact", "!room:example.com");
  const sends: unknown[][] = [];
  let encryptionChecks = 0;
  const matrix = {
    bot: "@wechatbot:example.com",
    ownerToken: "owner-secret",
    encrypted: async () => {
      encryptionChecks++;
      return false;
    },
    send: async (...args: unknown[]) => {
      sends.push(args);
      return `$event${sends.length}`;
    },
  } as unknown as Matrix;
  const bridge = new WeChatBridge(config, {} as WeChatBridge["runtime"], matrix, store);
  bridge["connection"] = { state: "logged_in", account: { id: "self" } };
  const portal = store.portal("self", "contact")!;
  const message: Message = {
    id: "1",
    account_id: "self",
    chat_id: "contact",
    chat_type: "direct",
    sender_id: "self",
    kind: "text",
    timestamp: 12345,
    own: true,
    text: "from WeChat",
  };
  return {
    bridge,
    config,
    store,
    sends,
    portal,
    message,
    encryptionChecks: () => encryptionChecks,
  };
}

test("own WeChat messages mirror as the real owner and remain editable", async () => {
  const f = await fixture();
  await f.bridge["receive"](f.message, f.portal);
  await f.bridge["receive"]({ ...f.message, text: "updated" }, f.portal);
  expect(f.sends).toHaveLength(2);
  expect(f.sends[0][0]).toBe(f.config.bridge.owner);
  expect(f.sends[1][3]).toMatchObject({
    "m.relates_to": { rel_type: "m.replace", event_id: "$event1" },
  });
  expect(f.store.mapping("self", "contact", "1")?.sender).toBe(f.config.bridge.owner);
});

test("double-puppet echoes never enter the outgoing queue", async () => {
  const f = await fixture();
  const event: MatrixEvent = {
    event_id: "$echo",
    room_id: f.portal.room,
    sender: f.config.bridge.owner,
    type: "m.room.message",
    content: { body: "from WeChat", "fi.mau.double_puppet_source": "matrix-wechat" },
  };
  f.bridge.accept(event);
  expect(f.store.queued()).toHaveLength(0);
  f.bridge.accept({ ...event, event_id: "$user", content: { body: "from Matrix" } });
  expect(f.store.queued()).toHaveLength(1);
});

test("room encryption checks are reused during import and encryption events take effect immediately", async () => {
  const f = await fixture();
  for (let i = 0; i < 100; i++) expect(await f.bridge.usable(f.portal.room)).toBe(true);
  expect(f.encryptionChecks()).toBe(1);
  f.bridge.accept({
    event_id: "$encryption",
    room_id: f.portal.room,
    sender: "@someone:example.com",
    type: "m.room.encryption",
    state_key: "",
    content: { algorithm: "m.megolm.v1.aes-sha2" },
  });
  expect(await f.bridge.usable(f.portal.room)).toBe(false);
});

test("a disconnected outgoing message stays queued and receives only one waiting notice", async () => {
  const f = await fixture();
  f.bridge["connection"] = { state: "disconnected" };
  f.bridge.accept({
    event_id: "$waiting",
    room_id: f.portal.room,
    sender: f.config.bridge.owner,
    type: "m.room.message",
    content: { msgtype: "m.text", body: "send after login" },
  });
  await f.bridge["jobs"]();
  await f.bridge["jobs"]();
  expect(f.store.queued()).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0][3]).toMatchObject({ body: expect.stringContaining("queued") });
});

test("missing images upgrade to labeled previews and then originals without repeated edits", async () => {
  const f = await fixture();
  const previewBytes = Buffer.alloc(24);
  previewBytes.set(Buffer.from("89504e470d0a1a0a", "hex"));
  previewBytes.writeUInt32BE(180, 16);
  previewBytes.writeUInt32BE(100, 20);
  const originalBytes = Buffer.concat([previewBytes, Buffer.from("original")]);
  originalBytes.writeUInt32BE(1800, 16);
  originalBytes.writeUInt32BE(1000, 20);
  let previewAvailable = false,
    originalAvailable = false;
  f.bridge.runtime.asset = async (kind) => {
    if (kind === "media" && originalAvailable)
      return { bytes: originalBytes, type: "image/png", name: undefined };
    if (kind === "thumbnail" && previewAvailable)
      return { bytes: previewBytes, type: "image/png", name: undefined };
    throw new APIError("media_unavailable", "Not cached");
  };
  f.bridge.matrix.upload = async (asset) => `mxc://example.com/${asset.bytes.length}`;
  const message: Message = {
    ...f.message,
    kind: "image",
    text: undefined,
    media: { id: "1", kind: "image", state: "pending", width: 1800, height: 1000 },
  };
  await f.bridge["receive"](message, f.portal);
  expect(f.sends[0][3]).toMatchObject({ msgtype: "m.notice" });
  previewAvailable = true;
  await f.bridge["retryMedia"]();
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1][3]).toMatchObject({
    "m.new_content": {
      msgtype: "m.image",
      body: expect.stringContaining("WeChat thumbnail; original not downloaded"),
      url: "mxc://example.com/24",
      info: { w: 180, h: 100 },
    },
    "m.relates_to": { rel_type: "m.replace", event_id: "$event1" },
  });
  expect(f.store.mapping("self", "contact", "1")?.media_retry).toBe(1);
  await f.bridge["retryMedia"]();
  const restarted = new WeChatBridge(f.config, f.bridge.runtime, f.bridge.matrix, f.store);
  restarted["connection"] = f.bridge["connection"];
  await restarted["retryMedia"]();
  previewAvailable = false;
  await restarted["retryMedia"]();
  expect(f.sends).toHaveLength(2);
  originalAvailable = true;
  await restarted["retryMedia"]();
  expect(f.sends).toHaveLength(3);
  expect(f.sends[2][3]).toMatchObject({
    "m.new_content": { msgtype: "m.image", body: "image.png", info: { w: 1800, h: 1000 } },
    "m.relates_to": { rel_type: "m.replace", event_id: "$event1" },
  });
  expect(f.store.mapping("self", "contact", "1")?.media_retry).toBe(0);
  await restarted["retryMedia"]();
  expect(f.sends).toHaveLength(3);
});

test("an original cached after receipt replaces the placeholder in the existing Matrix event", async () => {
  const f = await fixture();
  let cached = false;
  f.bridge.runtime.asset = async () => {
    if (!cached) throw new APIError("media_unavailable", "Not downloaded yet");
    return { bytes: Buffer.from("original image fixture"), type: "image/jpeg", name: undefined };
  };
  f.bridge.matrix.upload = async () => "mxc://example.com/original";
  const message = { ...f.message, kind: "image" };
  await f.bridge["receive"](message, f.portal);
  expect(f.sends[0][3]).toMatchObject({ msgtype: "m.notice" });
  cached = true;
  await f.bridge["retryMedia"]();
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1][3]).toMatchObject({
    "m.new_content": { msgtype: "m.image", url: "mxc://example.com/original" },
    "m.relates_to": { rel_type: "m.replace", event_id: "$event1" },
  });
  expect(f.store.mapping("self", "contact", "1")).toMatchObject({
    event: "$event1",
    media_retry: 0,
  });
});

test("media retries rotate past old failures, survive restart, and isolate individual errors", async () => {
  const f = await fixture();
  const attempted: string[] = [];
  const receive = async (message: Message) => {
    attempted.push(message.id);
    if (message.id === "1") throw new APIError("not_ready", "Transient failure");
    return true;
  };
  for (let i = 1; i <= 13; i++) {
    const message = { ...f.message, id: String(i), kind: "image" };
    f.store.saveMapping(
      message,
      `$old${i}`,
      f.config.bridge.owner,
      messageFingerprint(message),
      true,
    );
  }
  f.bridge["receive"] = receive;
  await f.bridge["retryMedia"]();
  expect(attempted).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
  const restarted = new WeChatBridge(f.config, f.bridge.runtime, f.bridge.matrix, f.store);
  restarted["connection"] = f.bridge["connection"];
  restarted["receive"] = receive;
  await restarted["retryMedia"]();
  expect(attempted.slice(10)).toEqual(["11", "12", "13"]);
  await restarted["retryMedia"]();
  expect(attempted.slice(13)).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
});
