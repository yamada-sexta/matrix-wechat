import { MatrixClient, setRequestFn } from "@vector-im/matrix-bot-sdk";
import { AppServiceRegistration, Bridge, Logger } from "matrix-appservice-bridge";
import type { Config } from "./config";
import type { Asset } from "./messages";
import { hash, type MatrixEvent } from "./store";

export class Matrix {
  readonly sdk: Bridge;
  readonly bot: string;
  private readonly ownerClient?: MatrixClient;
  private ownerJoined = new Set<string>();
  constructor(
    readonly config: Config,
    readonly registration: AppServiceRegistration,
    accept: (event: MatrixEvent) => void,
    queryGhost: (mxid: string) => boolean,
    readonly ownerToken = process.env.MATRIX_OWNER_AS_TOKEN,
  ) {
    // Keep the SDK's intents and APIs, with Bun's HTTP implementation. Bun 1.3's
    // undici shim lacks the BodyReadable.bytes() required by this SDK release.
    setRequestFn(
      async (
        url: URL,
        options: {
          method: string;
          headers: Record<string, string>;
          body?: BodyInit;
          headersTimeout?: number;
          bodyTimeout?: number;
        },
      ) => {
        const response = await fetch(url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          redirect: "error",
          signal: AbortSignal.timeout(options.bodyTimeout || options.headersTimeout || 60000),
        });
        return {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers),
          body: { bytes: () => response.bytes() },
        };
      },
    );
    if (ownerToken) {
      this.ownerClient = new MatrixClient(config.homeserver.address, ownerToken);
      this.ownerClient.impersonateUserId(config.bridge.owner);
    }
    this.bot = `@${config.appservice.bot_username}:${config.homeserver.domain}`;
    Logger.configure({ console: "warn" });
    this.sdk = new Bridge({
      homeserverUrl: config.homeserver.address,
      domain: config.homeserver.domain,
      registration,
      disableStores: true,
      disableContext: true,
      suppressEcho: true,
      intentOptions: { bot: { enablePresence: false }, clients: { enablePresence: false } },
      queue: { type: "per_room", perRequest: true },
      controller: {
        onUserQuery: (user) => (queryGhost(user.getId()) ? {} : null),
        onEvent: (request) => {
          try {
            // This is synchronous: the event is persisted before the SDK acknowledges it.
            accept(request.getData() as MatrixEvent);
            request.resolve(undefined);
          } catch (error) {
            request.reject(error);
            throw error;
          }
        },
      },
    });
  }
  async start() {
    if (this.ownerClient) {
      const identity = await this.ownerClient.getWhoAmI();
      if (identity.user_id !== this.config.bridge.owner)
        throw new Error("Matrix owner token does not match bridge.owner");
    }
    await this.sdk.run(this.config.appservice.port, undefined, this.config.appservice.hostname);
    try {
      await this.ensureBotAvatar();
    } catch {
      console.warn("Default WeChat bot avatar could not be set; bridging will continue");
    }
  }
  private async ensureBotAvatar() {
    const intent = this.sdk.getIntent();
    // Bridge.run assumes its sender is registered. Explicitly register it before
    // setting a profile: appservice authentication alone can use a virtual sender.
    await intent.ensureRegistered(true);
    let profile: { avatar_url?: string } = {};
    try {
      profile = await intent.matrixClient.getUserProfile(this.bot);
    } catch (error: any) {
      if (error.errcode !== "M_NOT_FOUND") throw error;
    }
    if (profile.avatar_url) return;
    const bytes = Buffer.from(
      await Bun.file(new URL("../assets/wechat.png", import.meta.url)).arrayBuffer(),
    );
    const avatar = await this.upload({ bytes, type: "image/png", name: "wechat.png" });
    await intent.setAvatarUrl(avatar);
  }
  async joinOwner(room: string) {
    if (!this.ownerClient || this.ownerJoined.has(room)) return room;
    let membership: unknown;
    try {
      membership = (
        await this.sdk
          .getIntent()
          .matrixClient.getRoomStateEventContent(room, "m.room.member", this.config.bridge.owner)
      ).membership;
    } catch (error: any) {
      if (error.errcode === "M_NOT_FOUND") return room;
      throw error;
    }
    if (membership === "invite") await this.ownerClient.joinRoom(room);
    if (membership === "invite" || membership === "join") this.ownerJoined.add(room);
    return room;
  }
  async close() {
    await this.sdk.close();
  }
  async createRoom(key: string, name: string, owner: string, direct: boolean) {
    const aliasLocalpart = `wechat_room_${hash(key)}`;
    const bot = this.sdk.getIntent();
    await bot.ensureRegistered();
    try {
      return await this.joinOwner(
        await bot.matrixClient.resolveRoom(`#${aliasLocalpart}:${this.config.homeserver.domain}`),
      );
    } catch (error: any) {
      if (error.errcode !== "M_NOT_FOUND") throw error;
    }
    try {
      return await this.joinOwner(
        (
          await bot.createRoom({
            options: {
              room_alias_name: aliasLocalpart,
              name,
              visibility: "private",
              preset: "private_chat",
              invite: [owner],
              is_direct: direct,
              initial_state: [
                {
                  type: "m.room.history_visibility",
                  state_key: "",
                  content: { history_visibility: "shared" },
                },
              ],
            },
          })
        ).room_id,
      );
    } catch (error: any) {
      if (error.errcode !== "M_ROOM_IN_USE") throw error;
      return this.joinOwner(
        await bot.matrixClient.resolveRoom(`#${aliasLocalpart}:${this.config.homeserver.domain}`),
      );
    }
  }
  async profile(mxid: string, name: string, avatar?: string) {
    const intent = this.sdk.getIntent(mxid);
    await intent.ensureRegistered();
    await intent.setDisplayName(name);
    if (avatar !== undefined) await intent.setAvatarUrl(avatar);
  }
  async membership(room: string, mxid: string, join: boolean) {
    const intent = this.sdk.getIntent(mxid);
    if (!join) {
      await intent.leave(room);
      return;
    }
    await intent.ensureRegistered();
    if (mxid === this.bot) {
      await intent.join(room);
      return;
    }
    try {
      if (
        (
          await this.sdk
            .getIntent()
            .matrixClient.getRoomStateEventContent(room, "m.room.member", mxid)
        ).membership === "join"
      )
        return;
    } catch (error: any) {
      if (error.errcode !== "M_NOT_FOUND") throw error;
    }
    await this.sdk.getIntent().invite(room, mxid);
    await intent.join(room);
  }
  async metadata(room: string, name: string, topic: string, avatar?: string) {
    const bot = this.sdk.getIntent();
    await bot.setRoomName(room, name);
    await bot.setRoomTopic(room, topic);
    if (avatar !== undefined) await bot.setRoomAvatar(room, avatar);
  }
  async powerLevels(room: string, content?: Record<string, any>): Promise<Record<string, any>> {
    const bot = this.sdk.getIntent();
    if (content) return bot.sendStateEvent(room, "m.room.power_levels", "", content);
    return bot.matrixClient.getRoomStateEventContent(room, "m.room.power_levels", "");
  }
  async send(
    sender: string,
    room: string,
    type: string,
    content: Record<string, any>,
    transaction: string,
    timestamp?: number,
  ) {
    if (sender === this.config.bridge.owner && this.ownerClient) {
      await this.joinOwner(room);
      const result = await this.ownerClient.doRequest(
        "PUT",
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${encodeURIComponent(type)}/${encodeURIComponent(transaction)}`,
        timestamp ? { ts: timestamp } : undefined,
        { ...content, "fi.mau.double_puppet_source": "matrix-wechat" },
      );
      if (!result.event_id) throw new Error("Matrix owner send returned no event ID");
      return result.event_id;
    }
    const intent = this.sdk.getIntent(sender);
    await intent.ensureRegistered();
    await intent.join(room);
    const result = await intent.matrixClient.doRequest(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${encodeURIComponent(type)}/${encodeURIComponent(transaction)}`,
      timestamp ? { ts: timestamp } : undefined,
      content,
    );
    return result.event_id as string;
  }
  async redact(room: string, event: string, transaction: string) {
    await this.sdk
      .getIntent()
      .matrixClient.doRequest(
        "PUT",
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/redact/${encodeURIComponent(event)}/${encodeURIComponent(transaction)}`,
        undefined,
        { reason: "Revoked in WeChat" },
      );
  }
  async upload(asset: Asset) {
    return this.sdk.getIntent().uploadContent(asset.bytes, { type: asset.type, name: asset.name });
  }
  async download(url: string, limit: number): Promise<Asset> {
    const match = url.match(/^mxc:\/\/([^/]+)\/([^/?#]+)$/);
    if (!match) throw new Error("Invalid Matrix media URL");
    const endpoint = `${this.config.homeserver.address.replace(/\/$/, "")}/_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${this.registration.getAppServiceToken()}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Matrix media download failed (${response.status})`);
    }
    if (Number(response.headers.get("Content-Length")) > limit) {
      await response.body?.cancel();
      throw new Error("Attachment exceeds the size limit");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty media response");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Attachment exceeds the size limit");
      }
      chunks.push(value);
    }
    return {
      bytes: Buffer.concat(chunks),
      type: response.headers.get("Content-Type")?.split(";")[0] || "application/octet-stream",
    };
  }
  async encrypted(room: string) {
    try {
      await this.sdk
        .getIntent()
        .matrixClient.getRoomStateEventContent(room, "m.room.encryption", "");
      return true;
    } catch (error: any) {
      if (error.errcode === "M_NOT_FOUND") return false;
      throw error;
    }
  }
}

export function generateRegistration(config: Config) {
  const registration = new AppServiceRegistration(config.appservice.address);
  registration.setId(`wechat-${hash(config.bridge.owner).slice(0, 16)}`);
  registration.setHomeserverToken(AppServiceRegistration.generateToken());
  registration.setAppServiceToken(AppServiceRegistration.generateToken());
  registration.setSenderLocalpart(config.appservice.bot_username);
  registration.setAppServiceUrl(config.appservice.address);
  registration.setProtocols(["wechat"]);
  const domain = config.homeserver.domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  registration.addRegexPattern("users", `^@wechat_[a-f0-9]{64}:${domain}$`, true);
  registration.addRegexPattern("aliases", `^#wechat_room_[a-f0-9]{64}:${domain}$`, true);
  registration.setRateLimited(false);
  return registration;
}
