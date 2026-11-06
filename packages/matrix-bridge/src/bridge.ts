import { APIError, errorCode, imageType, type Status, type WeChatClient } from "wechat-rpc";
import type { Config } from "./config";
import { ghostID, incoming, messageFingerprint, outgoing } from "./convert";
import type { Matrix } from "./matrix";
import {
  type Asset,
  type Contact,
  type Conversation,
  capabilities,
  checksum,
  type Group,
  type Message,
  sendFingerprint,
  unsupported,
} from "./messages";
import { hash, type Inbox, type Mapping, type MatrixEvent, type Portal, Store } from "./store";

const mediaKinds = new Set(["image", "sticker", "audio", "video", "file", "channels"]);
const pendingTimeout = 120000;
export class WeChatBridge {
  private busy = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private connection: Status = { state: "starting" };
  private lastMetadata = 0;
  private lastMediaRetry = 0;
  private usableRooms = new Set<string>();
  private management = "";
  private contacts = new Map<string, Contact>();
  private groups = new Map<string, Group>();
  private joined = new Set<string>();
  private rotation = 0;
  lastError = "";
  constructor(
    readonly config: Config,
    readonly runtime: WeChatClient,
    readonly matrix: Matrix,
    readonly store: Store,
  ) {}
  private async contactsList(): Promise<Contact[]> {
    return await this.runtime.rpc.contacts.query();
  }
  private async groupsList(): Promise<Group[]> {
    return await this.runtime.rpc.groups.query();
  }
  private async conversationsList(): Promise<Conversation[]> {
    return await this.runtime.rpc.conversations.query();
  }
  get account() {
    return this.connection.account?.id || "";
  }
  ghost(id: string) {
    return ghostID(this.account, id, this.config.homeserver.domain);
  }
  accept(event: MatrixEvent) {
    if (!event.event_id || !event.room_id || !event.sender || !event.content) return;
    if (
      event.sender === this.config.bridge.owner &&
      event.content["fi.mau.double_puppet_source"] === "matrix-wechat"
    )
      return;
    const knownRoom =
      Boolean(this.store.portalForRoom(event.room_id)) ||
      event.room_id === this.store.meta("management");
    if (event.type === "m.room.encryption" && event.state_key === "" && knownRoom) {
      this.store.setMeta(`encrypted:${event.room_id}`, "true");
      this.store.accept(event);
      return;
    }
    if (event.sender !== this.config.bridge.owner) return;
    if (!knownRoom) {
      if (
        event.type !== "m.room.member" ||
        event.state_key !== this.matrix.bot ||
        event.content.membership !== "invite"
      )
        return;
    }
    this.store.accept(event);
  }
  async start() {
    this.management =
      this.store.meta("management") ||
      (await this.matrix.createRoom(
        `management:${this.config.bridge.owner}`,
        "WeChat bridge",
        this.config.bridge.owner,
        true,
      ));
    this.store.setMeta("management", this.management);
    await this.matrix.joinOwner(this.management);
    for (const portal of this.store.all<{ room: string }>("SELECT room FROM portals"))
      await this.matrix.joinOwner(portal.room);
    await this.tick();
    this.timer = setInterval(() => void this.tick(), 1000);
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await Bun.sleep(25);
  }
  async notice(room: string, text: string, key: string) {
    await this.matrix.send(
      this.matrix.bot,
      room,
      "m.room.message",
      { msgtype: "m.notice", body: text },
      hash(key),
    );
  }
  async usable(room: string) {
    if (this.store.meta(`encrypted:${room}`)) return false;
    if (this.usableRooms.has(room)) return true;
    const encrypted = await this.matrix.encrypted(room);
    if (encrypted) {
      this.store.setMeta(`encrypted:${room}`, "true");
      await this.notice(
        room,
        "Encrypted Matrix rooms are unsupported. Bridging for this room is stopped.",
        `encrypted-room:${room}`,
      );
    }
    if (!encrypted) this.usableRooms.add(room);
    return !encrypted;
  }
  private async status(logoutConfirmed = false) {
    let snapshot;
    let failure: unknown;
    try {
      snapshot = await this.runtime.rpc.status.query();
    } catch (error) {
      failure = error;
      snapshot = { status: { state: "disconnected" as const } };
    }
    const previous = this.account;
    this.connection = snapshot.status;
    if (previous !== this.account) {
      this.lastMetadata = 0;
      this.contacts.clear();
      this.groups.clear();
      this.joined.clear();
    }
    const state = this.connection.state;
    await this.portalPermissions();
    // Preserve the last completed state while native logout is still pending.
    if (state === "logging_out") return false;
    const previousState = this.store.meta("connection_state");
    let logoutNotice = false;
    if (
      previousState === "logged_in" &&
      state !== "logged_in" &&
      !this.store.meta("login_required")
    ) {
      const generation = Number(this.store.meta("connection_generation") || "0") + 1;
      await this.notice(
        this.management,
        `${logoutConfirmed ? "WeChat logged out." : "WeChat connection lost. The desktop client may have stopped or restarted."} Live sync and sends are paused; unsent messages remain queued. Check status after the runtime recovers. If login is needed, send login prompt to request phone confirmation, or login qr for a new QR code.`,
        `logout:${generation}`,
      );
      this.store.setMeta("connection_generation", String(generation));
      this.store.setMeta("login_required", "true");
      logoutNotice = true;
    } else if (state === "logged_in" && this.store.meta("login_required")) {
      await this.notice(
        this.management,
        "WeChat connection restored. Live sync and queued sends are resuming.",
        `login-restored:${this.store.meta("connection_generation")}`,
      );
      this.store.setMeta("login_required", "");
    }
    this.store.setMeta("connection_state", state);
    if (failure) throw failure;
    return logoutNotice;
  }
  private portalWritable(portal: Portal) {
    const joined =
      this.groups.get(portal.chat)?.joined ?? JSON.parse(portal.metadata || "{}").joined;
    return (
      this.connection.state === "logged_in" && portal.account === this.account && joined !== false
    );
  }
  private async portalPermissions() {
    for (const portal of this.store.all<Portal>("SELECT * FROM portals")) {
      try {
        const writable = this.portalWritable(portal);
        const key = `owner_power:${portal.room}`;
        const saved = this.store.meta(key);
        let previous: { level: number | null; applied: boolean } | undefined = saved
          ? JSON.parse(saved)
          : undefined;
        if ((writable && !previous) || (!writable && previous?.applied)) continue;
        const levels = await this.matrix.powerLevels(portal.room);
        levels.users = { ...levels.users };
        if (!writable) {
          if (!previous) {
            previous = { level: levels.users[this.config.bridge.owner] ?? null, applied: false };
            this.store.setMeta(key, JSON.stringify(previous));
          }
          const thresholds = [
            levels.events_default ?? 0,
            levels.state_default ?? 50,
            ...Object.values(levels.events || {}),
          ] as number[];
          levels.users[this.config.bridge.owner] = Math.min(0, ...thresholds) - 1;
        } else if (previous!.level === null) delete levels.users[this.config.bridge.owner];
        else levels.users[this.config.bridge.owner] = previous!.level;
        await this.matrix.powerLevels(portal.room, levels);
        this.store.setMeta(key, writable ? "" : JSON.stringify({ ...previous, applied: true }));
      } catch (error) {
        this.lastError = errorCode(error) || "portal_permissions_failed";
        console.error("Portal permissions:", this.lastError);
      }
    }
  }
  private async loginQR(event: MatrixEvent) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot = await this.runtime.rpc.status.query();
      if (snapshot.status.state === "logged_in") return false;
      if (snapshot.qrAvailable) {
        const qr = await this.runtime.asset("qr");
        const mxc = await this.matrix.upload({
          bytes: qr.bytes,
          type: "image/png",
          name: "wechat-login.png",
        });
        await this.matrix.send(
          this.matrix.bot,
          event.room_id,
          "m.room.message",
          {
            msgtype: "m.image",
            body: "Scan with WeChat, then approve on your phone",
            url: mxc,
            info: { mimetype: "image/png", size: qr.bytes.length },
          },
          hash(`login-qr:${event.event_id}`),
        );
        return true;
      }
      await Bun.sleep(500);
    }
    throw new Error("QR code is not ready. Try login qr again.");
  }
  private async assetUpload(bytes: Buffer, type: string, name?: string) {
    const key = hash(`${this.account}:${type}:${name || ""}:${hash(bytes)}`);
    const existing = this.store.get<{ mxc: string }>("SELECT mxc FROM uploads WHERE key=?", key);
    if (existing) return existing.mxc;
    const mxc = await this.matrix.upload({ bytes, type, name });
    this.store.run("INSERT OR REPLACE INTO uploads VALUES(?,?)", key, mxc);
    return mxc;
  }
  private async ensureGhost(id: string) {
    const mxid = this.ghost(id),
      contact = this.contacts.get(id);
    const avatar = await this.avatar(id);
    const name = contact?.name || id;
    const previous = this.store.get<{ profile: string }>(
      "SELECT profile FROM ghosts WHERE account=? AND id=?",
      this.account,
      id,
    );
    const profile = JSON.stringify({
      name,
      avatar: avatar ?? JSON.parse(previous?.profile || "{}").avatar,
    });
    this.store.run(
      "INSERT OR IGNORE INTO ghosts(account,id,mxid) VALUES(?,?,?)",
      this.account,
      id,
      mxid,
    );
    if (previous?.profile !== profile) {
      await this.matrix.profile(mxid, name, avatar);
      this.store.run(
        "UPDATE ghosts SET profile=? WHERE account=? AND id=?",
        profile,
        this.account,
        id,
      );
    }
    return mxid;
  }
  private async avatar(id: string): Promise<string | undefined> {
    try {
      const asset = await this.runtime.asset("avatar", { id });
      return await this.assetUpload(asset.bytes, asset.type);
    } catch (error) {
      if (!["not_found", "media_unavailable"].includes(errorCode(error) || "")) throw error;
    }
  }
  private async joinGhost(room: string, id: string) {
    const key = `${room}:${id}`;
    if (this.joined.has(key)) return this.ghost(id);
    const mxid = await this.ensureGhost(id);
    await this.matrix.membership(room, mxid, true);
    this.joined.add(key);
    return mxid;
  }
  async ensurePortal(chat: string, name?: string) {
    const existing = this.store.portal(this.account, chat);
    if (existing) {
      await this.matrix.joinOwner(existing.room);
      return existing;
    }
    const room = await this.matrix.createRoom(
      JSON.stringify([this.account, chat]),
      name || this.groups.get(chat)?.name || this.contacts.get(chat)?.name || chat,
      this.config.bridge.owner,
      !chat.endsWith("@chatroom"),
    );
    this.store.addPortal(this.account, chat, room);
    return this.store.portal(this.account, chat)!;
  }
  private async metadata() {
    this.contacts = new Map((await this.contactsList()).map((contact) => [contact.id, contact]));
    this.groups = new Map((await this.groupsList()).map((group) => [group.id, group]));
    const conversations = await this.conversationsList();
    for (const conversation of conversations)
      await this.ensurePortal(conversation.id, conversation.name);
    for (const portal of this.store.portals(this.account)) {
      if (!(await this.usable(portal.room))) continue;
      const group = this.groups.get(portal.chat),
        contact = this.contacts.get(portal.chat);
      const name =
        group?.name ||
        contact?.name ||
        conversations.find((c) => c.id === portal.chat)?.name ||
        portal.chat;
      const avatar = await this.avatar(portal.chat);
      const previous = JSON.parse(portal.metadata || "{}");
      const members = [
        ...new Set([
          this.account,
          ...(group ? (group.members || []).map((m) => m.id) : [portal.chat]),
        ]),
      ].filter((id) => !(this.matrix.ownerToken && id === this.account));
      const metadata = JSON.stringify({
        name,
        topic: group?.topic || "",
        avatar: avatar ?? previous.avatar,
        members,
        joined: group?.joined ?? previous.joined,
      });
      if (portal.metadata !== metadata) {
        await this.matrix.metadata(portal.room, name, group?.topic || "", avatar);
        for (const id of members) await this.joinGhost(portal.room, id);
        for (const id of previous.members || [])
          if (!members.includes(id)) {
            await this.matrix.membership(portal.room, this.ghost(id), false);
            this.joined.delete(`${portal.room}:${id}`);
          }
        this.store.run(
          "UPDATE portals SET metadata=? WHERE account=? AND chat=?",
          metadata,
          this.account,
          portal.chat,
        );
      }
    }
    await this.portalPermissions();
    // Existing participant profiles can change without any roster change.
    for (const ghost of this.store.all<{ id: string }>(
      "SELECT id FROM ghosts WHERE account=?",
      this.account,
    ))
      await this.ensureGhost(ghost.id);
    this.lastMetadata = Date.now();
  }
  private async content(message: Message) {
    let asset: Asset | undefined, mxc;
    let thumbnail: Asset | undefined, thumbnailMxc;
    let missingMedia = false;
    if (mediaKinds.has(message.kind)) {
      try {
        asset = await this.runtime.asset("media", { chat: message.chat_id, id: message.id });
      } catch (error) {
        if (!["not_found", "media_unavailable", "unsupported"].includes(errorCode(error) || ""))
          throw error;
        missingMedia = errorCode(error) !== "unsupported";
        if (missingMedia && message.kind === "image") {
          try {
            asset = {
              ...(await this.runtime.asset("thumbnail", { chat: message.chat_id, id: message.id })),
              preview: true,
            };
          } catch (error) {
            if (!["not_found", "media_unavailable"].includes(errorCode(error) || "")) throw error;
          }
        }
      }
      if (asset) mxc = await this.assetUpload(asset.bytes, asset.type, asset.name);
    }
    if (message.link?.thumbnail) {
      try {
        thumbnail = await this.runtime.asset("thumbnail", {
          chat: message.chat_id,
          id: message.id,
        });
      } catch (error) {
        if (!["not_found", "media_unavailable"].includes(errorCode(error) || "")) throw error;
        missingMedia = true;
      }
      if (thumbnail) thumbnailMxc = await this.assetUpload(thumbnail.bytes, thumbnail.type);
    }
    return {
      ...incoming(message, {
        asset,
        mxc,
        missingMedia,
        thumbnail,
        thumbnailMxc,
        replyEvent: message.reply_to
          ? this.store.mapping(this.account, message.chat_id, message.reply_to)?.event
          : undefined,
        ghost: (id) => this.ghost(id),
        owner: this.config.bridge.owner,
      }),
      missingMedia,
      preview: !!asset?.preview,
    };
  }
  private held(message: Message) {
    if (!message.own) return false;
    // Correlation runs against authoritative recent source records before ingestion.
    return this.store
      .pending(this.account, message.chat_id)
      .some(
        (pending) =>
          pending.started > Date.now() - pendingTimeout &&
          !JSON.parse(pending.baseline).includes(message.id) &&
          message.timestamp * 1000 >= pending.started - 5000,
      );
  }
  private async receive(message: Message, portal: Portal) {
    if (message.account_id !== this.account) return false;
    const fingerprint = messageFingerprint(message);
    const existing = this.store.mapping(
      this.account,
      message.chat_id,
      message.id,
      message.local_key,
    );
    if (existing?.redacted) return true;
    if (existing && existing.fingerprint === fingerprint && !existing.media_retry) {
      if (existing.id !== message.id)
        this.store.saveMapping(message, existing.event, existing.sender, fingerprint);
      return true;
    }
    if (!(await this.usable(portal.room))) return false;
    if (!existing && this.held(message)) return false;
    // An echoed Matrix event belongs to the owner: don't impersonate or reupload it.
    if (
      existing?.sender === this.config.bridge.owner &&
      this.store.get("SELECT id FROM inbox WHERE id=?", existing.event)
    ) {
      this.store.saveMapping(message, existing.event, existing.sender, fingerprint);
      return true;
    }
    const sender =
      existing?.sender ||
      (message.kind === "system" || !message.sender_id
        ? this.matrix.bot
        : message.own && this.matrix.ownerToken && this.portalWritable(portal)
          ? this.config.bridge.owner
          : await this.joinGhost(portal.room, message.sender_id));
    const converted = await this.content(message);
    if (
      existing?.fingerprint === fingerprint &&
      converted.missingMedia &&
      (!converted.preview || this.store.meta(`media_preview:${existing.event}`) === "true")
    )
      return true;
    const originalType = existing ? this.store.meta(`message_type:${existing.event}`) : undefined;
    const edit = existing && originalType !== "m.sticker" && converted.type !== "m.sticker";
    const content = edit
      ? {
          ...converted.content,
          "m.new_content": converted.content,
          "m.relates_to": { rel_type: "m.replace", event_id: existing.event },
          body: `* ${converted.content.body}`,
        }
      : converted.content;
    const operation = hash(
      JSON.stringify([this.account, message.chat_id, message.local_key || message.id]),
    );
    const revision = this.store.revision(
      operation,
      JSON.stringify([
        fingerprint,
        converted.missingMedia,
        existing?.fingerprint,
        existing?.event,
        existing?.media_retry,
      ]),
    );
    const event = await this.matrix.send(
      sender,
      portal.room,
      converted.type,
      content,
      hash(`${operation}:${revision}`),
      message.timestamp * 1000,
    );
    if (existing && !edit)
      await this.matrix.redact(
        portal.room,
        existing.event,
        hash(`replace:${existing.event}:${event}`),
      );
    this.store.saveMapping(
      message,
      edit ? existing.event : event,
      sender,
      fingerprint,
      converted.missingMedia,
    );
    this.store.setMeta(`message_type:${edit ? existing.event : event}`, converted.type);
    this.store.setMeta(`media_preview:${edit ? existing.event : event}`, String(converted.preview));
    return true;
  }
  private async confirmPending(chat: string, recent: Message[]) {
    for (const pending of this.store.pending(this.account, chat)) {
      const baseline = new Set<string>(JSON.parse(pending.baseline));
      const candidates = [
        ...new Map(
          recent
            .filter(
              (message) =>
                message.own &&
                !message.id.startsWith("local:") &&
                !baseline.has(message.id) &&
                !baseline.has(message.local_key || "") &&
                message.timestamp * 1000 >= pending.started - 5000 &&
                message.timestamp * 1000 <= pending.started + pendingTimeout &&
                sendFingerprint(message) === pending.fingerprint,
            )
            .map((message) => [message.id, message]),
        ).values(),
      ];
      if (candidates.length === 1) {
        const message = candidates[0];
        const claimed = this.store.mapping(this.account, chat, message.id, message.local_key);
        if (!claimed || claimed.event === pending.id) {
          this.store.db.transaction(() => {
            this.store.saveMapping(
              message,
              pending.id,
              this.config.bridge.owner,
              messageFingerprint(message),
            );
            this.store.run("UPDATE inbox SET state='delivered' WHERE id=?", pending.id);
          })();
          continue;
        }
      }
      if (Date.now() - pending.started >= pendingTimeout && !pending.notice) {
        const event: MatrixEvent = JSON.parse(pending.payload);
        await this.notice(
          event.room_id,
          "WeChat delivery is uncertain. The bridge will not resend this message automatically.",
          `uncertain:${pending.id}`,
        );
        this.store.run("UPDATE inbox SET state='uncertain',notice=1 WHERE id=?", pending.id);
      }
    }
  }
  private async reconcile(portal: Portal) {
    if (!(await this.usable(portal.room))) return;
    const recent = await this.runtime.rpc.recent.query({ chat: portal.chat });
    await this.confirmPending(portal.chat, recent);
    const page = await this.runtime.rpc.history.query({
      chat: portal.chat,
      cursor: portal.cursor || undefined,
    });
    for (let index = 0; index < page.messages.length; index++) {
      const message = page.messages[index];
      if (!(await this.receive(message, portal))) this.store.queue(message);
      if ((index + 1) % 20 === 0) await this.jobs();
    }
    this.store.progress(this.account, portal.chat, page.cursor, page.done);
    // ID promotion and source updates don't necessarily advance a history keyset.
    if (page.done) {
      for (const message of recent.slice().reverse())
        if (!(await this.receive(message, portal))) this.store.queue(message);
      for (const row of this.store.all<{ key: string; payload: string }>(
        "SELECT key,payload FROM incoming WHERE account=? AND chat=? ORDER BY rowid LIMIT 200",
        this.account,
        portal.chat,
      )) {
        if (await this.receive(JSON.parse(row.payload), portal))
          this.store.run("DELETE FROM incoming WHERE key=?", row.key);
      }
    }
  }
  private async redactions() {
    for (const revoke of await this.runtime.rpc.revocations.query())
      this.store.run(
        "INSERT OR IGNORE INTO revocations VALUES(?,?,?)",
        this.account,
        revoke.chat,
        revoke.id,
      );
    for (const revoke of this.store.all<{ chat: string; id: string }>(
      "SELECT chat,id FROM revocations WHERE account=?",
      this.account,
    )) {
      const portal = this.store.portal(this.account, revoke.chat),
        mapping = this.store.mapping(this.account, revoke.chat, revoke.id);
      if (!portal || !mapping || mapping.redacted || !(await this.usable(portal.room))) continue;
      await this.matrix.redact(
        portal.room,
        mapping.event,
        hash(`revoke:${this.account}:${revoke.chat}:${revoke.id}`),
      );
      this.store.run(
        "UPDATE messages SET redacted=1,media_retry=0 WHERE account=? AND chat=? AND event=?",
        this.account,
        revoke.chat,
        mapping.event,
      );
    }
  }
  private async retryMedia() {
    const cursorKey = `media_retry_cursor:${this.account}`;
    const rows = this.store.all<Mapping & { retry_rowid: number }>(
      "SELECT rowid AS retry_rowid,* FROM messages WHERE account=? AND media_retry=1 AND redacted=0 AND rowid>? ORDER BY rowid LIMIT 10",
      this.account,
      Number(this.store.meta(cursorKey)) || 0,
    );
    for (const row of rows) {
      // Advance even when this attachment is unavailable or an individual read fails.
      this.store.setMeta(cursorKey, String(row.retry_rowid));
      try {
        const portal = this.store.portal(this.account, row.chat);
        if (portal) await this.receive(JSON.parse(row.payload), portal);
      } catch (error) {
        this.lastError = errorCode(error) || "media_retry_failed";
        console.error("Bridge media retry:", this.lastError);
      }
    }
    if (rows.length < 10) this.store.setMeta(cursorKey, "0");
  }
  private async command(event: MatrixEvent, text: string) {
    const [command, ...args] = text.trim().split(/\s+/);
    let response = "";
    if (command === "help")
      response =
        "Commands: help, login [qr|prompt], logout, status, capabilities, list contacts, list groups, start-chat <WeChat ID>, sync. Native mentions are received; outgoing text does not construct native mentions. Leaving a Matrix room does not leave the WeChat group.";
    else if (command === "status")
      response = `WeChat: ${this.connection.state}. Rooms: ${this.store.portals(this.account).length}. History imports pending: ${this.store.portals(this.account).filter((p) => !p.imported).length}.${this.lastError ? ` Last reconciliation error: ${this.lastError}.` : ""}`;
    else if (command === "capabilities") response = JSON.stringify(capabilities, null, 2);
    else if (command === "login") {
      const requested = args[0] || "prompt";
      if (requested !== "prompt" && requested !== "qr")
        throw new Error("Use login qr or login prompt");
      const snapshot = await this.runtime.rpc.status.query();
      if (snapshot.status.state === "logged_in") response = "WeChat is already logged in.";
      else {
        const mode = requested;
        await this.runtime.rpc.login.mutate({ mode });
        if (mode === "qr" && (await this.loginQR(event))) return;
        response =
          mode === "qr"
            ? "WeChat is already logged in."
            : "Phone confirmation requested. Approve the login in WeChat on your phone.";
      }
    } else if (command === "logout") {
      await this.runtime.rpc.logout.mutate();
      if (await this.status(true)) return;
      response = "WeChat is logged out. Use login qr or login prompt to sign in again.";
    } else if (command === "list" && args[0] === "contacts")
      response =
        (await this.contactsList()).map((c) => `${c.id}: ${c.name}`).join("\n") ||
        "No cached contacts.";
    else if (command === "list" && args[0] === "groups")
      response =
        (await this.groupsList()).map((g) => `${g.id}: ${g.name}`).join("\n") ||
        "No cached groups.";
    else if (command === "start-chat" && args.length === 1) {
      if (this.connection.state !== "logged_in") throw new Error("WeChat is not logged in");
      const known =
        (await this.contactsList()).some((c) => c.id === args[0]) ||
        (await this.conversationsList()).some((c) => c.id === args[0]);
      if (!known) throw new Error("Choose a cached contact or conversation ID");
      const portal = await this.ensurePortal(args[0]);
      response = `Opened https://matrix.to/#/${portal.room}`;
    } else if (command === "sync") {
      this.lastMetadata = 0;
      response = "Conversation discovery and cached-history synchronization requested.";
    } else response = "Unknown command. Send help for available commands.";
    await this.notice(event.room_id, response, `command:${event.event_id}`);
  }
  private commandText(event: MatrixEvent): string | undefined {
    if (event.type !== "m.room.message" || typeof event.content.body !== "string") return;
    const body = event.content.body,
      prefix = `${this.config.bridge.command_prefix} `;
    if (body.startsWith(prefix)) return body.slice(prefix.length);
    if (event.room_id === this.management) return body;
  }
  private async sendJob(job: Inbox, event: MatrixEvent) {
    if (event.type === "m.room.encryption" && event.state_key === "") {
      await this.notice(
        event.room_id,
        "Encrypted Matrix rooms are unsupported. Bridging for this room is stopped.",
        `encryption:${event.event_id}`,
      );
      return "done";
    }
    if (event.type === "m.room.member") {
      if (event.state_key === this.matrix.bot && event.content.membership === "invite") {
        await this.matrix.membership(event.room_id, this.matrix.bot, true);
        if (!this.store.portalForRoom(event.room_id)) {
          if (!(await this.usable(event.room_id)))
            throw new Error("Encrypted management rooms are unsupported");
          this.management = event.room_id;
          this.store.setMeta("management", this.management);
          await this.notice(
            event.room_id,
            "WeChat bridge management. Send help for commands.",
            `management:${event.event_id}`,
          );
        }
      }
      return "done";
    }
    if (!(await this.usable(event.room_id)))
      throw new Error("Encrypted Matrix rooms are unsupported");
    const command = this.commandText(event);
    if (command !== undefined) {
      await this.command(event, command);
      return "done";
    }
    const portal = this.store.portalForRoom(event.room_id);
    if (!portal) throw new Error("This room is not connected to the current WeChat account");
    if (event.type === "m.room.encrypted") unsupported("Encrypted messages");
    if (!["m.room.message", "m.reaction"].includes(event.type))
      unsupported(`Sending ${event.type}`);
    if (this.connection.state !== "logged_in")
      throw new APIError("not_ready", "WeChat is disconnected; send is waiting for login");
    if (portal.account !== this.account)
      throw new Error("This room is not connected to the current WeChat account");
    if (!this.portalWritable(portal))
      throw new Error("You are no longer a member of this WeChat chat");
    // At most one unresolved native send per chat makes identical-send correlation safe.
    if (
      this.store
        .pending(this.account, portal.chat)
        .some(
          (p) =>
            p.state !== "uncertain" || !p.notice || Date.now() - p.started < pendingTimeout + 5000,
        )
    )
      return "wait";
    const message = outgoing(event.content, event.type);
    let bytes: Buffer | undefined;
    let name = "",
      reply: string | undefined;
    if (message.kind === "text" && message.reply) {
      reply = this.store.eventMapping(this.account, portal.chat, message.reply)?.id;
      if (!reply || !/^\d{1,20}$/.test(reply))
        throw new Error("Reply target has no confirmed WeChat server ID in this conversation");
    }
    if (message.kind !== "text") {
      const asset = await this.matrix.download(
        message.url,
        message.kind === "image" ? 20 * 1024 * 1024 : 64 * 1024 * 1024,
      );
      bytes = asset.bytes;
      name = message.name;
      if (
        !bytes.length ||
        name === "." ||
        name === ".." ||
        Buffer.byteLength(name) > 200 ||
        /[/\\\x00-\x1f\x7f]/.test(name)
      )
        throw new Error("Invalid attachment filename or empty attachment");
      if (
        message.kind === "image" &&
        !["image/png", "image/jpeg", "image/gif"].includes(imageType(bytes) || "")
      )
        unsupported("This image format; upload it as a file instead");
      if (message.video && bytes.subarray(4, 8).toString() !== "ftyp")
        unsupported("Video formats other than MP4");
    }
    const fingerprint =
      message.kind === "text"
        ? JSON.stringify(["text", message.text, reply || ""])
        : JSON.stringify(["attachment", checksum(bytes!)]);
    const baseline = (await this.runtime.rpc.recent.query({ chat: portal.chat })).flatMap((m) => [
      m.id,
      m.local_key || m.id,
    ]);
    this.store.run(
      "UPDATE inbox SET state='sending',notice=0,account=?,chat=?,fingerprint=?,baseline=?,started=? WHERE id=?",
      this.account,
      portal.chat,
      fingerprint,
      JSON.stringify(baseline),
      Date.now(),
      job.id,
    );
    try {
      if (message.kind === "text")
        await this.runtime.rpc.send.mutate({
          chat_id: portal.chat,
          kind: "text",
          text: message.text,
          reply_to: reply,
        });
      else if (message.kind === "image")
        await this.runtime.upload(portal.chat, bytes!, name, "image");
      else await this.runtime.upload(portal.chat, bytes!, name, "file");
    } catch (error) {
      // Explicit preflight/rejection errors are safe failures; unknown native errors may have sent.
      const safe = [
        "invalid_params",
        "not_ready",
        "unsupported",
        "unverified",
        "send_failed",
      ].includes(errorCode(error) || "");
      this.store.run("UPDATE inbox SET state=? WHERE id=?", safe ? "failed" : "uncertain", job.id);
      throw error;
    }
    return "submitted";
  }
  private async jobs() {
    for (const job of this.store.queued(this.management, `${this.config.bridge.command_prefix} `)) {
      const event: MatrixEvent = JSON.parse(job.payload);
      try {
        const state = await this.sendJob(job, event);
        if (state !== "wait") this.store.run("UPDATE inbox SET state=? WHERE id=?", state, job.id);
      } catch (error) {
        const current = this.store.get<Inbox>("SELECT * FROM inbox WHERE id=?", job.id)!;
        if (
          errorCode(error) === "not_ready" &&
          current.state === "queued" &&
          this.commandText(event) === undefined
        ) {
          if (!current.notice) {
            await this.notice(
              event.room_id,
              "This message is queued while WeChat is disconnected. Send login prompt in the WeChat management room to resume login; it will be sent after login succeeds.",
              `waiting-login:${job.id}`,
            );
            this.store.run("UPDATE inbox SET notice=1 WHERE id=?", job.id);
          }
          continue;
        }
        const uncertain = current.state === "uncertain";
        await this.notice(
          event.room_id,
          uncertain
            ? "WeChat delivery is uncertain. This message will not be resent automatically."
            : `Unable to bridge: ${error instanceof Error ? error.message : "operation failed"}`,
          `failure:${job.id}`,
        );
        this.store.run(
          "UPDATE inbox SET state=?,notice=1 WHERE id=?",
          uncertain ? "uncertain" : "failed",
          job.id,
        );
      }
    }
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.usableRooms.clear();
    try {
      await this.status();
      await this.jobs();
      if (this.connection.state === "logged_in") {
        if (Date.now() - this.lastMetadata >= 60000) await this.metadata();
        else
          for (const conversation of await this.conversationsList())
            await this.ensurePortal(conversation.id, conversation.name);
      }
      await this.jobs();
      if (this.connection.state !== "logged_in") return;
      for (const row of this.store.all<{ chat: string }>(
        "SELECT DISTINCT chat FROM incoming WHERE account=?",
        this.account,
      ))
        await this.ensurePortal(row.chat);
      const portals = this.store.portals(this.account);
      const start = this.rotation++ % Math.max(portals.length, 1);
      for (let index = 0; index < portals.length; index++) {
        if (this.stopped) break;
        const portal = portals[(start + index) % portals.length];
        try {
          await this.reconcile(portal);
        } catch (error) {
          this.lastError = errorCode(error) || "reconciliation_failed";
          console.error("Bridge reconciliation:", this.lastError);
        }
        await this.jobs();
      }
      await this.redactions();
      if (Date.now() - this.lastMediaRetry >= 5000) {
        this.lastMediaRetry = Date.now();
        await this.retryMedia();
      }
    } catch (error) {
      this.lastError = errorCode(error) || "bridge_operation_failed";
      console.error("Bridge:", this.lastError);
    } finally {
      this.busy = false;
    }
  }
}
