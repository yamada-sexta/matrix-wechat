import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type * as frida from "frida";
import {
  outboundProfileSchema,
  sessionProfileSchema,
  storageProfileSchema,
} from "wechat-native/profiles";
import {
  attachmentChecksum,
  receivedFile,
  receivedImage,
  receivedImageThumbnail,
  receivedThumbnail,
  receivedVideo,
} from "./attachments";
import { voiceAudioProcess } from "./audio";
import { DownloadRetry } from "./download-retry";
import { loginQRImage } from "./login-qr";
import { imageType, sharedCardAsset, stickerImage } from "./media";
import { loginRequestSchema, textMessageSchema, validateParams } from "./schemas";
import { databaseAccount, Storage } from "./storage";
import { APIError, type Database, type Event, type Message, type Row, type Status } from "./types";

const outbound = outboundProfileSchema.parse(
  Bun.TOML.parse(
    await Bun.file(new URL(import.meta.resolve("wechat-native/outbound_profile.toml"))).text(),
  ),
);
const profile = storageProfileSchema.parse(
  Bun.TOML.parse(
    await Bun.file(new URL(import.meta.resolve("wechat-native/storage_profile.toml"))).text(),
  ),
);
const sessionProfile = sessionProfileSchema.parse(
  Bun.TOML.parse(
    await Bun.file(new URL(import.meta.resolve("wechat-native/session_profile.toml"))).text(),
  ),
);
for (const metadata of [outbound, sessionProfile])
  if (metadata.elf_sha256 !== profile.artifact.sha256)
    throw new APIError("unsupported_build", "Native profiles reference different client builds");

const root = join(import.meta.dir, ".."),
  data = process.env.WECHAT_DATA_DIR || "/home/wechat/.cache/wechatlinux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const adapterPath = join(root, "dist/native/download.so");
const owlHash = "f5d7874c73cde5cb3044668dad9374221e9fda30e7573eda143930fb4cf5560f";
async function sha(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function privateWrite(path: string, bytes: Uint8Array | string) {
  const temporary = path + ".tmp";
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}
function blobs(v: any): any {
  if (Array.isArray(v)) return v.map(blobs);
  if (v && typeof v === "object") {
    if (Object.keys(v).length === 1 && Array.isArray(v.bytes))
      return { base64: Buffer.from(v.bytes).toString("base64") };
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blobs(x)]));
  }
  return v;
}
export class Runtime {
  readonly store = new Storage(
    {
      databases: () => this.native("databases"),
      query: async (id, sql, limit) => blobs(await this.native("query", id, sql, limit)),
    },
    () => this.account,
  );
  status: Status = { state: "starting" };
  account = "";
  qr: Buffer | undefined;
  qrAt = 0;
  stopped = false;
  private device?: frida.Device;
  private session?: frida.Session;
  private script?: frida.Script;
  private pid = 0;
  private xvfb?: Bun.Subprocess;
  private display = "";
  private dirty = true;
  private baseline = false;
  private loginRequested = false;
  private autoLoginSuppressed = false;
  private lastQR = 0;
  private lastLoginRetry = new Map<"prompt" | "qr", number>();
  private serial: Promise<any> = Promise.resolve();
  private subscribers = new Set<(e: Event) => void>();
  private sendReady = false;
  private downloadAccount = "";
  private downloadArtifact = "";
  private downloadRetries = new DownloadRetry();
  verified = new Set<string>();
  private uploads = new Map<
    string,
    { path: string; cachedPath?: string; size: number; directory?: string }
  >();

  private checkUploadReady(size: number) {
    if (this.status.state !== "logged_in" || !this.sendReady)
      throw new APIError("not_ready", "WeChat is still initializing");
    const pendingBytes = [...this.uploads.values()].reduce(
      (total, upload) => total + upload.size,
      0,
    );
    if (this.uploads.size >= 8 || pendingBytes + size > 64 * 1024 * 1024)
      throw new APIError("not_ready", "Too many uploads; try again shortly");
  }

  private async cleanupUpload(token: string) {
    const upload = this.uploads.get(token);
    if (!upload) return;
    this.uploads.delete(token);
    await unlink(upload.path).catch(() => {});
    if (upload.cachedPath) await unlink(upload.cachedPath).catch(() => {});
    if (upload.directory) await rmdir(upload.directory).catch(() => {});
  }

  async sendFile(chat: string, bytes: Buffer, name: string) {
    if (
      !chat ||
      chat.length > 256 ||
      !bytes.length ||
      bytes.length > 64 * 1024 * 1024 ||
      !name ||
      name === "." ||
      name === ".." ||
      Buffer.byteLength(name) > 200 ||
      /[/\\\x00-\x1f\x7f]/.test(name)
    )
      throw new APIError("invalid_params", "Choose a file up to 64 MiB with a valid filename");
    return this.operation(async () => {
      this.checkUploadReady(bytes.length);
      const token = randomUUID(),
        directory = join(data, "uploads", token),
        path = join(directory, name);
      const checksum = createHash("md5").update(bytes).digest("hex");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      this.uploads.set(token, { path, directory, size: bytes.length });
      const cleanup = () => this.cleanupUpload(token);
      try {
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      } catch (error) {
        await cleanup();
        throw error;
      }
      const timer = setTimeout(() => void cleanup(), 120000);
      timer.unref();
      const response = await this.native("sendfile", chat, path, name);
      if (response.success !== true) {
        clearTimeout(timer);
        await cleanup();
        throw new APIError("send_failed", response.error_message || "WeChat rejected the file");
      }
      // The native callback acknowledges queueing, before the asynchronous CDN upload.
      // Retain the source until a server ID appears; reconcile without blocking other operations.
      const started = Date.now() / 1000;
      const finish = async () => {
        for (let attempt = 0; attempt < 100 && !this.stopped; attempt++) {
          await sleep(1000);
          try {
            const page = await this.operation(() =>
              this.store.history({ chat_id: chat, limit: 50 }),
            );
            if (
              page.messages.some(
                (m) =>
                  m.own &&
                  ["file", "video"].includes(m.kind) &&
                  m.timestamp >= started - 2 &&
                  !m.id.startsWith("local:") &&
                  attachmentChecksum(m) === checksum,
              )
            ) {
              clearTimeout(timer);
              await cleanup();
              this.verified.add("send.file");
              return;
            }
          } catch {}
        }
      };
      void finish();
      this.dirty = true;
      return { success: true, acknowledgement: "native_handler" };
    });
  }

  async sendImage(chat: string, bytes: Buffer) {
    const type = imageType(bytes);
    if (
      !chat ||
      chat.length > 256 ||
      !bytes.length ||
      bytes.length > 20 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/gif"].includes(type || "")
    )
      throw new APIError(
        "invalid_params",
        "Choose a PNG, JPEG or GIF image up to 20 MiB; use File for other formats",
      );
    return this.operation(async () => {
      this.checkUploadReady(bytes.length);
      const token = randomUUID();
      const started = Date.now() / 1000,
        checksum = createHash("md5").update(bytes).digest("hex");
      const directory = join(data, "uploads"),
        path = join(directory, token + "." + (type === "image/jpeg" ? "jpg" : type!.slice(6)));
      const [database] = await this.store.databases();
      const accountRoot = database.path.split("/db_storage/")[0];
      const cachedDirectory = join(
        accountRoot,
        "cache",
        new Date().toISOString().slice(0, 7),
        "HttpResource",
      );
      const cachedPath = join(cachedDirectory, createHash("md5").update(path).digest("hex"));
      this.uploads.set(token, {
        path,
        cachedPath,
        size: bytes.length,
      });
      const cleanup = () => this.cleanupUpload(token);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        await mkdir(cachedDirectory, { recursive: true, mode: 0o700 });
        await writeFile(cachedPath, bytes, { mode: 0o600, flag: "wx" });
      } catch (error) {
        await cleanup();
        throw error;
      }
      const timer = setTimeout(() => void cleanup(), 120000);
      timer.unref();
      let response;
      try {
        response = await this.native("sendimage", chat, path);
      } catch (error) {
        // Delivery is uncertain after a lost callback. Keep the source for a
        // possible queued native upload, bounded by the existing expiry timer.
        throw error;
      }
      if (response.success !== true) {
        clearTimeout(timer);
        await cleanup();
        throw new APIError("send_failed", response.error_message || "WeChat rejected the image");
      }
      // This callback acknowledges queueing, not CDN upload completion. Retain
      // both the original and native HttpResource cache until a server ID appears.
      const finish = async () => {
        for (let attempt = 0; attempt < 100 && !this.stopped; attempt++) {
          await sleep(1000);
          try {
            const page = await this.operation(() =>
              this.store.history({ chat_id: chat, limit: 50 }),
            );
            if (
              page.messages.some(
                (message) =>
                  message.own &&
                  message.kind === "image" &&
                  message.timestamp >= started - 2 &&
                  !message.id.startsWith("local:") &&
                  attachmentChecksum(message) === checksum,
              )
            ) {
              clearTimeout(timer);
              await cleanup();
              this.verified.add("send.image");
              return;
            }
          } catch {}
        }
      };
      void finish();
      this.dirty = true;
      return { success: true, acknowledgement: "native_handler" };
    });
  }
  onEvent(fn: (e: Event) => void) {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
  emit(e: Event) {
    for (const fn of this.subscribers) fn(e);
  }
  private updateStatus(status: Status) {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return;
    this.status = status;
    this.emit({ type: "login.state", data: { status } });
  }
  private clearQR() {
    this.qr = undefined;
    this.qrAt = 0;
    this.lastQR = 0;
  }
  private clearSession() {
    this.account = "";
    this.sendReady = false;
    this.baseline = false;
    this.loginRequested = false;
    this.dirty = true;
    this.store.invalidate();
    this.clearQR();
  }
  private updateSessionStatus(state: {
    logged_in: boolean;
    login?: { active?: boolean; phase?: number; request?: number };
  }) {
    if (state.logged_in && this.account) {
      this.updateStatus({ state: "logged_in", account: { id: this.account } });
      this.clearQR();
      return;
    }
    if (this.status.state === "logged_in" || this.status.state === "logging_out")
      this.clearSession();
    const login = state.login;
    this.updateStatus({
      state:
        state.logged_in || !login?.active || (login.phase === 4 && login.request === 6)
          ? "signing_in"
          : [3, 4].includes(login.phase ?? -1)
            ? "awaiting_confirmation"
            : "awaiting_scan",
    });
  }
  async login(params: Row) {
    const { mode } = validateParams(loginRequestSchema, params);
    return this.operation(async () => {
      if (this.status.state === "logged_in") return { success: true };
      if (
        mode === "qr" &&
        this.status.state === "awaiting_scan" &&
        this.qr &&
        Date.now() - this.qrAt <= 8000
      )
        return { success: true };
      if (Date.now() - (this.lastLoginRetry.get(mode) || 0) < 5000)
        throw new APIError("not_ready", "Please wait a few seconds before trying again");
      const result = await this.native("login", mode);
      if (!result.queued && result.reason === "qr_required")
        throw new APIError("not_ready", "WeChat cannot request phone confirmation. Use login qr.");
      if (!result.queued) throw new APIError("not_ready", "WeChat login is not ready yet");
      this.lastLoginRetry.set(mode, Date.now());
      this.autoLoginSuppressed = false;
      this.loginRequested = true;
      this.clearQR();
      return { success: true };
    });
  }
  async logout(): Promise<{ success: true }> {
    return this.operation(async () => {
      const previous = this.status;
      this.autoLoginSuppressed = true;
      this.clearQR();
      this.updateStatus({ state: "logging_out" });
      try {
        await this.native("logout");
        const state = await this.native("status");
        if (state.logged_in) throw new APIError("logout_failed", "WeChat has not logged out");
        this.updateSessionStatus(state);
        if (previous.state === "logged_in") this.verified.add("logout");
        return { success: true };
      } catch (error) {
        // Do not turn a failed logout into a fictitious signed-out session.
        const state = await this.native("status").catch(() => undefined);
        if (state) this.updateSessionStatus(state);
        else this.updateStatus({ state: "disconnected" });
        throw error instanceof APIError && error.code === "native_error"
          ? new APIError("logout_failed", "WeChat did not confirm logout")
          : error;
      }
    });
  }
  operation<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serial.then(fn);
    this.serial = task.catch(() => {});
    return task;
  }
  async native(method: string, ...args: any[]) {
    if (!this.script || this.stopped) throw new APIError("disconnected", "WeChat is disconnected");
    try {
      return await this.script.exports[method](...args);
    } catch (e) {
      await appendFile(join(data, "native-errors.log"), method + ": " + String(e) + "\n", {
        mode: 0o600,
      });
      throw new APIError("native_error", "Native operation failed");
    }
  }
  async executable() {
    const image = process.env.WECHAT_APPIMAGE || "/opt/wechat-client/WeChatLinux_x86_64.AppImage";
    const imageHash = await sha(image);
    if (imageHash !== profile.artifact.appimage_sha256)
      throw new APIError("unsupported_build", "AppImage does not match the pinned SHA-256");
    const extracted = process.env.WECHAT_INSTALL_DIR || join(data, "app-" + imageHash.slice(0, 16)),
      executable = join(extracted, "opt/wechat/wechat");
    if (!existsSync(executable)) {
      const handle = openSync(image, "r"),
        buffer = Buffer.alloc(2 * 1024 * 1024);
      let offset = -1;
      try {
        const n = readSync(handle, buffer, 0, buffer.length, 0);
        let start = 0;
        while (start < n) {
          start = buffer.indexOf("hsqs", start);
          if (start < 0) break;
          if (start + 32 < n && buffer.readUInt16LE(start + 28) === 4) {
            offset = start;
            break;
          }
          start += 4;
        }
      } finally {
        closeSync(handle);
      }
      if (offset < 0) throw new APIError("unsupported_build", "Unsupported AppImage");
      const process = Bun.spawn(
        ["unsquashfs", "-no-progress", "-d", extracted, "-o", String(offset), image],
        { stdout: "ignore", stderr: "pipe" },
      );
      if (await process.exited)
        throw new APIError("extraction_failed", "AppImage extraction failed");
    }
    if ((await sha(executable)) !== profile.artifact.sha256)
      throw new APIError("unsupported_build", "WeChat executable does not match the pinned build");
    return executable;
  }
  async start() {
    if (!existsSync("/run/.containerenv") && !existsSync("/.dockerenv"))
      throw new APIError("container_required", "WeChat must run inside its container");
    const frida = await import("frida");
    await mkdir(data, { recursive: true, mode: 0o700 });
    const executable = await this.executable();
    if (existsSync(adapterPath)) {
      if ((await sha(join(executable, "../libowl.so"))) !== owlHash)
        throw new APIError(
          "unsupported_build",
          "Native coroutine library does not match the pinned build",
        );
      this.downloadArtifact = await sha(adapterPath);
      try {
        const path = join(data, "download-verified.json"),
          info = await stat(path);
        if (info.size <= 4096 && info.uid === process.getuid?.() && !(info.mode & 0o077)) {
          const proof = JSON.parse(await readFile(path, "utf8"));
          if (
            proof.adapter === this.downloadArtifact &&
            proof.client === profile.artifact.sha256 &&
            proof.owl === owlHash &&
            typeof proof.account === "string"
          )
            this.downloadAccount = proof.account;
        }
      } catch {}
    }
    this.xvfb = Bun.spawn(
      ["Xvfb", "-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const reader = (this.xvfb.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    this.display = ":" + new TextDecoder().decode(first.value).trim();
    if (this.display === ":") throw new APIError("launch_failed", "Display did not start");
    this.device = await frida.getLocalDevice();
    this.device.output.connect((_pid, _fd, bytes) => {
      if (bytes.length) {
        void stat(join(data, "client-output.log"))
          .then((s) =>
            s.size > 1048576 ? privateWrite(join(data, "client-output.log"), "") : undefined,
          )
          .catch(() => {})
          .then(() => appendFile(join(data, "client-output.log"), bytes, { mode: 0o600 }))
          .catch(() => {});
      }
    });
    this.pid = await this.device.spawn([executable], {
      env: { DISPLAY: this.display, QT_QPA_PLATFORM: "xcb" },
      stdio: frida.Stdio.Pipe,
    });
    this.session = await this.device.attach(this.pid);
    this.session.detached.connect((reason, crash) => {
      if (!this.stopped) {
        console.error(
          "Native WeChat connection closed:",
          JSON.stringify({
            reason,
            crash: crash ? { pid: crash.pid, summary: crash.summary } : null,
          }),
        );
        this.updateStatus({ state: "disconnected" });
        this.emit({ type: "connection.closed" });
      }
    });
    const source =
      "const PROFILE=" +
      JSON.stringify(profile) +
      ";\nconst OUTBOUND=" +
      JSON.stringify(outbound) +
      ";\nconst SESSION=" +
      JSON.stringify(sessionProfile) +
      ";\nconst DOWNLOAD_ADAPTER=" +
      JSON.stringify(adapterPath) +
      ";\n" +
      (await readFile(join(root, "dist/native/instrument.js"), "utf8"));
    this.script = await this.session.createScript(source);
    let initialized = false,
      initialError = false;
    this.script.message.connect((message) => {
      if (message.type === "send") {
        const p = message.payload;
        if (p.type === "ready") initialized = true;
        else if (p.type === "change_hint") {
          if (p.kind.startsWith("login_")) this.clearQR();
          if (p.kind === "login_view_open") {
            this.loginRequested = false;
            this.sendReady = false;
          }
          this.dirty = true;
          this.store.invalidate();
        }
      } else if (message.type === "error") {
        initialError = true;
        console.error("Native instrumentation error:", message.description);
      }
    });
    await this.script.load();
    for (let i = 0; i < 50 && !initialized && !initialError; i++) await sleep(100);
    if (!initialized || initialError)
      throw new APIError("initialization_failed", "Native hooks did not initialize");
    await this.device.resume(this.pid);
    console.log("Native WeChat started inside container");
    void this.monitor();
  }
  private async refreshQR() {
    const payload = await this.native("loginqr"),
      image = loginQRImage(Buffer.from(payload.bytes));
    if (!image) return false;
    this.qr = image;
    this.qrAt = Date.now();
    await privateWrite(join(data, "login-qr.png"), this.qr);
    this.verified.add("login.qr");
    return true;
  }
  private async monitor() {
    while (!this.stopped) {
      try {
        await this.operation(async () => {
          const state = await this.native("status"),
            dbs: Database[] = await this.native("databases");
          const accounts = new Set(
            dbs
              .filter((d) => d.readable && d.active)
              .map((d) => databaseAccount(d.path))
              .filter(Boolean),
          );
          if (!state.logged_in || accounts.size > 1) this.account = "";
          else if (accounts.size === 1) this.account = [...accounts][0]!;
          this.updateSessionStatus(state);
          if (this.status.state === "logged_in") {
            if (this.dirty || !this.baseline) {
              this.dirty = false;
              try {
                const changes = await this.store.changes();
                this.baseline = true;
                for (const event of changes) {
                  this.emit(event);
                  if (event.message) this.verified.add("receive." + event.message.kind);
                }
              } catch (e) {
                this.dirty = true;
                if (!(e instanceof APIError) || !["not_ready"].includes(e.code))
                  console.error(
                    "Message reconciliation:",
                    e instanceof APIError ? e.code : "failed",
                  );
              }
            }
            if (!this.sendReady) {
              const probe = await this.native("sendprobe");
              if (probe.success !== false)
                throw new APIError(
                  "probe_failed",
                  "Native send probe did not reject invalid parameters",
                );
              this.sendReady = true;
              console.log("Native send callback ABI validated");
            }
          } else {
            this.baseline = false;
            if (
              !state.logged_in &&
              process.env.WECHAT_AUTO_LOGIN === "true" &&
              !this.autoLoginSuppressed &&
              !this.loginRequested &&
              state.login?.can_resume &&
              (state.login.phase === 5 || (state.login.phase === 4 && state.login.request === 2))
            ) {
              const result = await this.native("login", "prompt");
              this.loginRequested = result.queued === true;
            }
            if (state.login?.phase === 0 && Date.now() - this.lastQR > 4000) {
              this.lastQR = Date.now();
              await this.refreshQR();
            }
          }
        });
      } catch (e) {
        if (e instanceof APIError && e.code === "disconnected")
          this.updateStatus({ state: "disconnected" });
        else console.error("Client initialization:", e instanceof APIError ? e.code : "failed");
      }
      await sleep(1500);
    }
  }
  async dispatch(method: string, params: Row = {}) {
    if (method === "download.validate") return this.validateDownload(params);
    if (method === "download.status")
      return {
        enabled: this.downloadAccount === this.account && !!this.account,
        adapter_available: !!this.downloadArtifact,
      };
    if (method === "send.inspect")
      return this.operation(() => this.native("traces", params.enabled, params.clear));
    if (method === "status") return this.status;
    if (method === "login.inspect") return this.operation(() => this.native("status"));
    if (method === "capabilities")
      return {
        capabilities: [...this.verified].map((name) => ({
          name,
          status: "verified",
        })),
        sending_ready: this.sendReady,
        event_source: "native_database_write_hooks",
        direct_message_callback: "unverified",
      };
    if (method === "login") return this.login(params);
    if (method === "logout") return this.logout();
    return this.operation(async () => {
      if (this.status.state !== "logged_in")
        throw new APIError("not_ready", "WeChat is still signing in");
      if (method === "contacts") return this.store.contacts();
      if (method === "groups") return this.store.groups();
      if (method === "conversations") return this.store.conversations();
      if (method === "history") return this.store.history(params);
      if (method === "inspect_db") return this.store.inspect();
      if (method === "send") {
        if (!this.sendReady) throw new APIError("not_ready", "Sending is still initializing");
        if (params.kind !== "text")
          throw new APIError("unverified", "This message type is not yet verified");
        const message = validateParams(textMessageSchema, params);
        let response;
        if (message.reply_to !== undefined) {
          const quoted = await this.store.message(message.chat_id, message.reply_to);
          if (quoted.kind === "system")
            throw new APIError("invalid_params", "System messages cannot be quoted");
          const contacts = await this.store.contacts();
          const reference = {
            id: quoted.id,
            local_id: Number(quoted.native?.local_id),
            type: Number(quoted.native?.row.local_type),
            sender: quoted.sender_id,
            name:
              contacts.contacts.find((contact) => contact.id === quoted.sender_id)?.name ||
              quoted.sender_id,
            timestamp: Math.floor(quoted.timestamp * 1000),
            content: quoted.native?.decoded_content || quoted.text || `[${quoted.kind}]`,
          };
          response = await this.native("sendreply", message.chat_id, message.text, reference);
        } else response = await this.native("sendtext", message.chat_id, message.text);
        if (response.success !== true)
          throw new APIError(
            "send_failed",
            response.error_message || "WeChat rejected the message",
          );
        this.dirty = true;
        this.verified.add("send.text");
        return {
          success: true,
          message_id: response.message_id ? String(response.message_id) : undefined,
          timestamp: response.create_time ? Number(response.create_time) : undefined,
          acknowledgement: "native_handler",
        };
      }
      throw new APIError("unknown_method", "Unknown API method");
    });
  }
  async avatar(id: string) {
    return this.operation(async () => {
      if (this.status.state !== "logged_in")
        throw new APIError("not_ready", "WeChat is still signing in");
      const bytes = await this.store.avatar(id),
        type = imageType(bytes);
      if (!type) throw new APIError("media_unavailable", "Unsupported profile picture format");
      return { bytes, type };
    });
  }
  async media(chat: string, id: string) {
    const { message, voice } = await this.operation(async () => {
      if (this.status.state !== "logged_in")
        throw new APIError("not_ready", "WeChat is still signing in");
      const message = await this.store.message(chat, id);
      return {
        message,
        voice: message.kind === "audio" ? await this.store.voice(message) : undefined,
      };
    });
    if (voice) return voiceAudioProcess(voice);
    if (message.kind === "channels") return sharedCardAsset(message, join(data, "media"));
    if (message.kind === "image") {
      try {
        return await receivedImage(message);
      } catch (error) {
        if (
          error instanceof APIError &&
          error.code === "media_unavailable" &&
          this.downloadAccount &&
          message.account_id === this.account &&
          this.account === this.downloadAccount &&
          this.status.state === "logged_in" &&
          /^[1-9]\d{0,19}$/.test(message.id) &&
          BigInt(message.id) <= 0xffffffffffffffffn &&
          /^[a-f0-9]{32}$/.test(attachmentChecksum(message))
        ) {
          this.downloadRetries.request(
            JSON.stringify([message.account_id, message.chat_id, message.id]),
            () => this.requestNativeDownload(message, false),
          );
        }
        throw error;
      }
    }
    if (message.kind === "file") return receivedFile(message);
    if (message.kind === "video") return receivedVideo(message);
    return stickerImage(message, join(data, "media"));
  }
  async thumbnail(chat: string, id: string) {
    const message = await this.operation(() => {
      if (this.status.state !== "logged_in")
        throw new APIError("not_ready", "WeChat is still signing in");
      return this.store.message(chat, id);
    });
    if (message.kind === "image") return receivedImageThumbnail(message);
    try {
      return await receivedThumbnail(message);
    } catch (error) {
      if (!(error instanceof APIError) || error.code !== "media_unavailable") throw error;
    }
    return sharedCardAsset(message, join(data, "media"), true);
  }
  private async requestNativeDownload(message: Message, smoke: boolean) {
    await this.native("downloadinit");
    const generation = await this.operation(async () => {
      const state = await this.native("status");
      const dbs: Database[] = await this.native("databases");
      const accounts = new Set(
        dbs
          .filter((d) => d.active && d.readable)
          .map((d) => databaseAccount(d.path))
          .filter(Boolean),
      );
      if (
        !state.logged_in ||
        this.account !== message.account_id ||
        accounts.size !== 1 ||
        !accounts.has(message.account_id) ||
        !state.download_generation
      )
        throw new APIError("not_ready", "WeChat account changed before native download");
      return state.download_generation;
    });
    return this.native(
      "downloadimage",
      message.account_id,
      message.chat_id,
      message.id,
      smoke,
      generation,
    );
  }
  private async validateDownload(params: Row) {
    if (!this.downloadArtifact) throw new APIError("not_ready", "Native adapter is unavailable");
    const message = await this.operation(async () => {
      if (this.status.state !== "logged_in" || !this.sendReady)
        throw new APIError("not_ready", "WeChat is still initializing");
      if (typeof params.chat_id !== "string" || typeof params.message_id !== "string")
        throw new APIError("invalid_params", "An incoming image is required");
      const message = await this.store.message(params.chat_id, params.message_id);
      if (
        message.account_id !== this.account ||
        message.kind !== "image" ||
        !/^[1-9]\d{0,19}$/.test(message.id) ||
        BigInt(message.id) > 0xffffffffffffffffn ||
        !/^[a-f0-9]{32}$/.test(attachmentChecksum(message))
      )
        throw new APIError(
          "invalid_params",
          "An incoming image with original metadata is required",
        );
      return message;
    });
    let missing = false;
    try {
      await receivedImage(message);
    } catch (error) {
      if (error instanceof APIError && error.code === "media_unavailable") missing = true;
      else throw error;
    }
    if (!missing)
      throw new APIError("invalid_params", "Choose an image whose original is not cached");
    const smoke = await this.requestNativeDownload(message, true);
    if (!smoke.smoke) throw new APIError("native_error", "Native coroutine smoke test failed");
    const requested = await this.requestNativeDownload(message, false);
    if (!requested.requested)
      throw new APIError("native_error", "Native original request was rejected");
    for (let attempt = 0; attempt < 60; attempt++) {
      if (
        this.status.state !== "logged_in" ||
        this.account !== message.account_id ||
        !(await this.native("status")).logged_in
      )
        throw new APIError("not_ready", "WeChat account changed during validation");
      try {
        const original = await receivedImage(message);
        await privateWrite(
          join(data, "download-verified.json"),
          JSON.stringify({
            adapter: this.downloadArtifact,
            client: profile.artifact.sha256,
            owl: owlHash,
            account: message.account_id,
          }),
        );
        this.downloadAccount = message.account_id;
        return {
          smoke: true,
          original_verified: true,
          bytes: original.bytes.length,
          automatic_downloads: true,
        };
      } catch (error) {
        if (!(error instanceof APIError) || error.code !== "media_unavailable") throw error;
      }
      await sleep(1000);
    }
    throw new APIError(
      "media_unavailable",
      "Native request did not produce a verified original; automatic requests remain disabled",
    );
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.all([...this.uploads.keys()].map((token) => this.cleanupUpload(token)));
    this.qr = undefined;
    try {
      if (this.pid && this.device) await this.device.kill(this.pid);
    } catch {}
    try {
      await this.session?.detach();
    } catch {}
    this.xvfb?.kill();
  }
}
