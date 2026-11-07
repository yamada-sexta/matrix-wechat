import { createHash } from "node:crypto";
import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { channelMedia } from "./media";
import {
  APIError,
  type Contact,
  type Database,
  type Event,
  type Group,
  type Message,
  type NativeDB,
  type Row,
} from "./types";
export const identifier = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export const databaseAccount = (path: string) =>
  path.match(/\/xwechat_files\/([^/]+)\/db_storage\//)?.[1]?.replace(/_[0-9a-f]{4}$/, "");
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const num = (v: any) => Number(v) || 0;
const md5 = (v: string) => createHash("md5").update(v).digest("hex");
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  processEntities: true,
});
export type ChangeScope = ReadonlyMap<string, ReadonlySet<string> | null>;
function xml(value: any): Row | undefined {
  if (typeof value !== "string" || value.length > 2097152 || /<!DOCTYPE|<!ENTITY/i.test(value))
    return;
  try {
    return xmlParser.parse(value);
  } catch {
    return;
  }
}
export class Storage {
  private schema = new Map<
    string,
    { id: string; version: string; tables: Map<string, string[]>; triggers: boolean }
  >();
  private snapshot: Map<string, Message> | undefined;
  private snapshotAccount = "";
  private paths = new Set<string>();
  private revokes = new Map<string, Row>();
  constructor(
    private native: NativeDB,
    private account: () => string,
  ) {}
  invalidate(path?: string) {
    if (path) this.schema.delete(path);
    else this.schema.clear();
  }
  async databases() {
    const account = this.account();
    const dbs = (await this.native.databases()).filter(
      (d) => d.readable && account && databaseAccount(d.path) === account,
    );
    if (!dbs.length) throw new APIError("not_ready", "Account data is still opening");
    return dbs;
  }
  async query(db: Database, sql: string, limit = 50000): Promise<Row[]> {
    const r = await this.native.query(db.id, sql, limit + 1);
    if (r.truncated || r.rows.length > limit)
      throw new APIError("scan_limit", "Read exceeded the safety limit");
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
  }
  async tables(db: Database) {
    const version = String((await this.query(db, "PRAGMA schema_version", 1))[0]?.schema_version);
    const cached = this.schema.get(db.path);
    if (cached?.id === db.id && cached.version === version) return cached.tables;
    const map = new Map<string, string[]>();
    let triggers = false;
    for (const row of await this.query(
      db,
      "SELECT name,sql,type FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%'",
    )) {
      if (row.type === "trigger") {
        triggers = true;
        continue;
      }
      if (/virtual table/i.test(row.sql || "") || /fts/i.test(row.name)) continue;
      map.set(
        row.name,
        (await this.query(db, "PRAGMA table_info(" + identifier(row.name) + ")")).map(
          (r) => r.name,
        ),
      );
    }
    if (String((await this.query(db, "PRAGMA schema_version", 1))[0]?.schema_version) !== version)
      throw new APIError("not_ready", "Database schema changed during discovery");
    this.schema.set(db.path, { id: db.id, version, tables: map, triggers });
    return map;
  }
  async inspect() {
    const out = [];
    for (const d of await this.databases())
      out.push({
        ...d,
        tables: [...(await this.tables(d))].map(([name, columns]) => ({
          name,
          columns,
        })),
      });
    return { databases: out };
  }
  async contacts() {
    const out = new Map<string, Contact>();
    let recognized = false;
    for (const d of await this.databases()) {
      if (!basename(d.path).startsWith("contact")) continue;
      for (const [t, c] of await this.tables(d)) {
        const username = c.includes("username")
          ? "username"
          : c.includes("user_name")
            ? "user_name"
            : "";
        if (!username || !(c.includes("nick_name") || c.includes("remark"))) continue;
        recognized = true;
        for (const r of await this.query(d, "SELECT * FROM " + identifier(t))) {
          if (typeof r[username] !== "string" || !r[username]) continue;
          out.set(r[username], {
            id: r[username],
            name: r.remark || r.nick_name || "",
            avatar: r.big_head_url || r.small_head_url || undefined,
            native: r,
          });
        }
      }
    }
    if (!recognized) throw new APIError("not_ready", "Contacts are still opening");
    return { contacts: [...out.values()] };
  }
  async groups() {
    const { contacts } = await this.contacts();
    const groups = new Map<string, Group>(
      contacts.filter((c) => c.id.endsWith("@chatroom")).map((c) => [c.id, { ...c, members: [] }]),
    );
    const byID = new Map(
      contacts.filter((c) => c.native?.id).map((c) => [String(c.native!.id), c]),
    );
    const rosters = new Set<string>();
    for (const d of await this.databases()) {
      if (!basename(d.path).startsWith("contact")) continue;
      const tables = await this.tables(d);
      const rooms = new Map<string, string>();
      if (tables.has("chat_room"))
        for (const r of await this.query(d, "SELECT * FROM chat_room")) {
          rooms.set(String(r.id), r.username);
          if (!groups.has(r.username))
            groups.set(r.username, { id: r.username, name: "", members: [] });
          groups.get(r.username)!.native = {
            ...groups.get(r.username)!.native,
            room: r,
          };
        }
      if (tables.has("chat_room_info_detail"))
        for (const r of await this.query(d, "SELECT * FROM chat_room_info_detail")) {
          const g = groups.get(r.username_);
          if (g) {
            g.topic = r.announcement_ || "";
            g.native = { ...g.native, detail: r };
          }
        }
      if (tables.has("chatroom_member")) {
        for (const username of rooms.values()) rosters.add(username);
        for (const r of await this.query(d, "SELECT * FROM chatroom_member")) {
          const g = groups.get(rooms.get(String(r.room_id)) || ""),
            m = byID.get(String(r.member_id));
          if (g && m) g.members!.push(m);
        }
      }
    }
    for (const group of groups.values()) {
      if (rosters.has(group.id) && contacts.some((c) => c.id === this.account()))
        group.joined = group.members!.some((m) => m.id === this.account());
      if (!group.name)
        group.name =
          group.members
            ?.slice()
            .sort((a, b) => Number(a.id === this.account()) - Number(b.id === this.account()))
            .map((member) => member.native?.nick_name || member.name)
            .filter(Boolean)
            .slice(0, 3)
            .join(", ") || "Group chat";
    }
    return { groups: [...groups.values()] };
  }
  async conversations() {
    let recognized = false;
    const conversations = [];
    for (const d of await this.databases()) {
      if (basename(d.path) !== "session.db") continue;
      const tables = await this.tables(d);
      if (!tables.has("SessionTable")) continue;
      const titles = new Map<string, string>();
      if (tables.has("SessionNoContactInfoTable"))
        for (const row of await this.query(
          d,
          "SELECT username,session_title FROM SessionNoContactInfoTable",
        ))
          if (row.session_title) titles.set(row.username, row.session_title);
      recognized = true;
      for (const r of await this.query(d, "SELECT * FROM SessionTable"))
        if (r.username && !num(r.is_hidden))
          conversations.push({
            id: r.username,
            name: titles.get(r.username),
            chat_type: r.username.endsWith("@chatroom") ? ("group" as const) : ("direct" as const),
            unread_count: num(r.unread_count),
            last_timestamp: num(r.sort_timestamp || r.last_timestamp),
          });
    }
    if (!recognized) throw new APIError("not_ready", "Conversations are still opening");
    return { conversations };
  }
  private normalize(
    d: Database,
    t: string,
    row: Row,
    names: Map<string, string>,
    chat: string,
  ): [string, Message] {
    const r = { ...row };
    const decoded = r.__decoded,
      source = r.__source;
    delete r.__decoded;
    delete r.__source;
    const key = JSON.stringify([d.path, t, String(r.local_id)]);
    const server = String(r.server_id || "0");
    const sender = names.get(String(r.real_sender_id)) || "";
    const type = num(r.local_type) % 4294967296;
    const kind: Record<number, string> = {
      1: "text",
      3: "image",
      34: "audio",
      43: "video",
      47: "sticker",
      48: "location",
      10000: "system",
      10002: "system",
    };
    const content = typeof decoded === "string" ? decoded : r.message_content;
    const readable =
      typeof content === "string" &&
      (!num(r.WCDB_CT_message_content) || typeof decoded === "string");
    const m: Message = {
      local_key: digest(key),
      id: server !== "0" ? server : "local:" + digest(key),
      account_id: this.account(),
      chat_id: chat,
      chat_type: chat.endsWith("@chatroom") ? "group" : "direct",
      sender_id: sender,
      kind: kind[type] || "unknown",
      timestamp: num(r.create_time),
      own: !!sender && sender === this.account(),
      native: {
        database: d.path,
        table: t,
        row: r,
        local_id: String(r.local_id),
        content_decoded: readable,
        decoded_content: readable ? content : undefined,
        sender_resolved: !!sender,
      },
    };
    if (["text", "system"].includes(m.kind) && readable) m.text = content;
    if (
      m.kind === "text" &&
      m.chat_type === "group" &&
      sender &&
      m.text?.startsWith(sender + ":\n")
    )
      m.text = m.text.slice(sender.length + 2);
    const root = readable ? xml(content) : undefined;
    const system = root?.sysmsg;
    if (system) {
      m.kind = "system";
      m.read_only = true;
      m.system = {
        type:
          system.type === "paymsg"
            ? "payment_reminder"
            : system.type === "revokemsg"
              ? "revocation"
              : "notice",
      };
      const body = system.content || system.revokemsg?.replacemsg || system.replacemsg;
      const text = typeof body === "string" ? body.replace(/<[^>]*>/g, "").trim() : "";
      const decodedText = text ? xml(`<text>${text}</text>`)?.text : undefined;
      m.text =
        typeof decodedText === "string" && decodedText ? decodedText : "WeChat system message";
    }
    const app = root?.msg?.appmsg || root?.appmsg;
    if (type === 49 && app) {
      if (String(app.type) === "6") m.kind = "file";
      if (String(app.type) === "8") m.kind = "sticker";
      if (String(app.type) === "62" && app.patinfo) {
        m.kind = "system";
        m.text = String(app.title || "Tickle");
      }
      if (String(app.type) === "57") {
        m.kind = "text";
        m.text = app.title || "";
        if (app.refermsg?.svrid) m.reply_to = String(app.refermsg.svrid);
        if (app.refermsg)
          m.quote = {
            sender_id: String(app.refermsg.fromusr || ""),
            sender_name: String(app.refermsg.displayname || ""),
            text:
              Number(app.refermsg.type) === 1
                ? String(app.refermsg.content || "")
                : Number(app.refermsg.type) === 49
                  ? String(xml(app.refermsg.content)?.msg?.appmsg?.title || "[Message]")
                  : (
                      {
                        3: "[Image]",
                        34: "[Audio]",
                        43: "[Video]",
                        47: "[Sticker]",
                        48: "[Location]",
                      } as Record<number, string>
                    )[Number(app.refermsg.type)] || "[Message]",
            type: Number(app.refermsg.type) || 0,
          };
      }
      if (String(app.type) === "5" && typeof app.url === "string") {
        try {
          const url = new URL(app.url);
          if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
            m.kind = "link";
            m.link = {
              url: url.href,
              title: String(app.title || url.hostname),
              description: String(app.des || ""),
              source: String(app.sourcedisplayname || ""),
              thumbnail: !!(app.thumburl || app.appattach?.cdnthumbmd5),
            };
          }
        } catch {}
      }
      if (String(app.type) === "51" && app.finderFeed) {
        const feed = app.finderFeed,
          media = channelMedia(app);
        let url = "";
        try {
          const value = new URL(String(app.url || ""));
          if (["https:", "http:"].includes(value.protocol) && !value.username && !value.password)
            url = value.href;
        } catch {}
        m.kind = "channels";
        m.link = {
          url,
          title: String(feed.desc || app.title || "WeChat Channels"),
          description: String(media?.title || ""),
          source: String(feed.nickname || "WeChat Channels"),
          thumbnail: !!(media?.coverUrl || media?.thumbUrl),
        };
        m.media = {
          id: m.id,
          kind: "video",
          state: "pending",
          width: num(media?.width),
          height: num(media?.height),
          duration: num(media?.videoPlayDuration) * 1000,
        };
      }
      if (["2000", "2001"].includes(String(app.type))) {
        const pay = app.wcpayinfo || {},
          transfer = String(app.type) === "2000";
        m.kind = transfer ? "transfer" : "red_packet";
        m.read_only = true;
        m.payment = {
          title: transfer ? "Transfer" : "Red packet",
          amount: typeof pay.feedesc === "string" ? pay.feedesc : undefined,
          description: String(
            transfer
              ? pay.pay_memo || ""
              : (m.own ? pay.sendertitle : pay.receivertitle) || "Best wishes",
          ),
        };
        m.text = [m.payment.title, m.payment.amount, m.payment.description]
          .filter(Boolean)
          .join("\n");
      }
    }
    const location = root?.msg?.location || root?.location;
    if (m.kind === "location" && location) {
      const latitude = Number(location.x),
        longitude = Number(location.y);
      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180
      )
        m.location = { latitude, longitude, label: location.label || "" };
    }
    const src = typeof source === "string" ? source : !num(r.WCDB_CT_source) ? r.source : undefined;
    const mentions = xml(src)?.msgsource?.atuserlist;
    if (typeof mentions === "string" && mentions) m.mentions = mentions.split(",").filter(Boolean);
    if (["image", "sticker", "video", "audio", "file"].includes(m.kind))
      m.media = { id: m.id, kind: m.kind, state: "pending" };
    if (m.media) {
      const metadata = root?.msg || root;
      m.media.checksum =
        String(metadata?.videomsg?.md5 || app?.md5 || metadata?.img?.md5 || "").toLowerCase() ||
        undefined;
    }
    if (m.kind === "file" && app && m.media) {
      m.media.name = String(app.title || "File");
      const size = Number(app.appattach?.totallen);
      if (Number.isSafeInteger(size) && size >= 0) m.media.size = size;
    }
    return [key, m];
  }
  private async messages(chatFilter?: string, scope?: ChangeScope) {
    const { sources, paths, scannedPaths, scannedTables } = await this.messageSources(
      chatFilter,
      scope,
    );
    const messages = new Map<string, Message>();
    for (const source of sources) {
      let after = "0";
      while (true) {
        const page = await this.query(
          source.db,
          `SELECT ${source.projection} FROM ${identifier(source.table)} WHERE local_id>${literal(after)} ORDER BY local_id ASC LIMIT 500`,
          500,
        );
        for (const row of page) {
          after = String(row.local_id);
          const [key, message] = this.normalize(
            source.db,
            source.table,
            row,
            source.names,
            source.chat,
          );
          messages.set(key, message);
        }
        if (page.length < 500) break;
      }
    }
    return { messages, paths, scannedPaths, scannedTables };
  }
  async history(params: Row) {
    const chat = params.chat_id,
      limit = params.limit ?? 50;
    if (typeof chat !== "string" || !chat || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new APIError("invalid_params", "A chat and limit between 1 and 500 are required");
    let rows = [
      ...new Map([...(await this.messages(chat)).messages.values()].map((m) => [m.id, m])).values(),
    ].sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
    if (params.cursor) {
      let c: Row;
      try {
        c = JSON.parse(Buffer.from(params.cursor, "base64").toString());
        if (c.chat_id !== chat || typeof c.timestamp !== "number" || typeof c.id !== "string")
          throw Error();
      } catch {
        throw new APIError("invalid_params", "Invalid history cursor");
      }
      rows = rows.filter(
        (m) =>
          m.timestamp < c.timestamp ||
          (m.timestamp === c.timestamp && m.id.localeCompare(c.id) < 0),
      );
    }
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      messages: page,
      next_cursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                chat_id: chat,
                timestamp: last.timestamp,
                id: last.id,
              }),
            ).toString("base64")
          : undefined,
    };
  }
  private async messageSources(chatFilter?: string, scope?: ChangeScope) {
    const sources: {
      db: Database;
      table: string;
      chat: string;
      names: Map<string, string>;
      projection: string;
    }[] = [];
    const paths = new Set<string>();
    const scannedPaths = new Set<string>(),
      scannedTables = new Set<string>();
    for (const db of await this.databases()) {
      if (!/^message_\d+\.db$/.test(basename(db.path))) continue;
      paths.add(db.path);
      if (scope && !scope.has(db.path)) continue;
      const previousSchema = this.schema.get(db.path);
      const tables = await this.tables(db),
        names = new Map<string, string>();
      const requested = scope?.get(db.path);
      const currentSchema = this.schema.get(db.path)!;
      const narrow =
        requested &&
        previousSchema?.id === db.id &&
        previousSchema.version === currentSchema.version &&
        !currentSchema.triggers &&
        ![...requested].some(
          (t) =>
            t.toLowerCase() === "name2id" ||
            ![...tables.keys()].some((n) => n.toLowerCase() === t.toLowerCase()),
        );
      if (narrow)
        for (const table of requested)
          scannedTables.add(JSON.stringify([db.path, table.toLowerCase()]));
      else scannedPaths.add(db.path);
      if (tables.has("Name2Id"))
        for (const row of await this.query(db, "SELECT rowid AS __id,* FROM Name2Id"))
          names.set(String(row.__id), row.user_name);
      const chats = new Map([...names.values()].map((name) => ["msg_" + md5(name), name]));
      for (const [table, columns] of tables) {
        if (
          !table.toLowerCase().startsWith("msg_") ||
          (narrow && ![...requested].some((t) => t.toLowerCase() === table.toLowerCase())) ||
          (chatFilter && table.toLowerCase() !== "msg_" + md5(chatFilter))
        )
          continue;
        if (
          !["local_id", "real_sender_id", "create_time", "local_type", "message_content"].every(
            (key) => columns.includes(key),
          )
        )
          throw new APIError("unsupported_schema", "Unsupported message schema");
        const chat = chats.get(table.toLowerCase());
        if (!chat) throw new APIError("not_ready", "Conversation mapping is still opening");
        let projection = "*";
        if (columns.includes("WCDB_CT_message_content"))
          projection += ",wcdb_decompress(message_content,WCDB_CT_message_content) AS __decoded";
        if (columns.includes("WCDB_CT_source"))
          projection += ",wcdb_decompress(source,WCDB_CT_source) AS __source";
        sources.push({ db, table, chat, names, projection });
      }
    }
    if (!paths.size) throw new APIError("not_ready", "Message history is still opening");
    return { sources, paths, scannedPaths, scannedTables };
  }
  async bridgeRecent(chat: string, limit = 50) {
    if (!chat || chat.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new APIError("invalid_params", "Invalid recent history request");
    const rows: Message[] = [];
    for (const source of (await this.messageSources(chat)).sources) {
      for (const row of await this.query(
        source.db,
        `SELECT ${source.projection} FROM ${identifier(source.table)} ORDER BY create_time DESC,local_id DESC LIMIT ${limit}`,
        limit,
      )) {
        rows.push(this.normalize(source.db, source.table, row, source.names, chat)[1]);
      }
    }
    return rows
      .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))
      .slice(0, limit);
  }
  async bridgeHistory(chat: string, cursor?: string, limit = 200) {
    if (!chat || chat.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new APIError("invalid_params", "Invalid bridge history request");
    let positions: Record<string, { time: number; local: string }> = {};
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          decoded.account !== this.account() ||
          decoded.chat !== chat ||
          !decoded.positions ||
          typeof decoded.positions !== "object" ||
          Array.isArray(decoded.positions)
        )
          throw Error();
        for (const position of Object.values(decoded.positions) as {
          time: number;
          local: string;
        }[])
          if (
            !position ||
            !Number.isSafeInteger(position.time) ||
            typeof position.local !== "string" ||
            !/^\d+$/.test(position.local)
          )
            throw Error();
        positions = decoded.positions;
      } catch {
        throw new APIError("invalid_params", "Invalid bridge history cursor");
      }
    }
    const candidates: { key: string; local: string; message: Message }[] = [];
    for (const source of (await this.messageSources(chat)).sources) {
      const key = JSON.stringify([source.db.path, source.table]),
        after = positions[key];
      const where = after
        ? ` WHERE create_time>${literal(String(after.time))} OR (create_time=${literal(String(after.time))} AND local_id>${literal(after.local)})`
        : "";
      for (const row of await this.query(
        source.db,
        `SELECT ${source.projection} FROM ${identifier(source.table)}${where} ORDER BY create_time ASC,local_id ASC LIMIT ${limit + 1}`,
        limit + 1,
      )) {
        const local = String(row.local_id);
        candidates.push({
          key,
          local,
          message: this.normalize(source.db, source.table, row, source.names, chat)[1],
        });
      }
    }
    candidates.sort(
      (a, b) =>
        a.message.timestamp - b.message.timestamp ||
        a.key.localeCompare(b.key) ||
        (BigInt(a.local) < BigInt(b.local) ? -1 : BigInt(a.local) > BigInt(b.local) ? 1 : 0),
    );
    const page = candidates.slice(0, limit);
    for (const row of page) positions[row.key] = { time: row.message.timestamp, local: row.local };
    return {
      messages: page.map((row) => row.message),
      cursor: Buffer.from(JSON.stringify({ account: this.account(), chat, positions })).toString(
        "base64url",
      ),
      done: candidates.length <= limit,
    };
  }
  async avatar(id: string) {
    if (!id || id.length > 256)
      throw new APIError("invalid_params", "A user or conversation is required");
    for (const db of await this.databases()) {
      if (basename(db.path) !== "head_image.db") continue;
      const rows = await this.query(
        db,
        "SELECT image_buffer FROM head_image WHERE username=" +
          literal(id) +
          " ORDER BY update_time DESC LIMIT 1",
        1,
      );
      const blob = rows[0]?.image_buffer;
      if (blob?.base64) {
        const bytes = Buffer.from(blob.base64, "base64");
        if (bytes.length && bytes.length <= 5 * 1024 * 1024) return bytes;
      }
    }
    throw new APIError("not_found", "Profile picture is not cached yet");
  }
  async message(chat: string, id: string) {
    if (!chat || !id || chat.length > 256 || id.length > 256)
      throw new APIError("invalid_params", "A conversation and message are required");
    let message: Message | undefined;
    if (/^\d+$/.test(id))
      for (const source of (await this.messageSources(chat)).sources) {
        const rows = await this.query(
          source.db,
          `SELECT ${source.projection} FROM ${identifier(source.table)} WHERE server_id=${literal(id)} LIMIT 1`,
          1,
        );
        if (rows[0]) {
          message = this.normalize(source.db, source.table, rows[0], source.names, chat)[1];
          break;
        }
      }
    else {
      let cursor: string | undefined;
      do {
        const page = await this.bridgeHistory(chat, cursor, 500);
        message = page.messages.find((row) => row.id === id);
        cursor = page.done ? undefined : page.cursor;
      } while (!message && cursor);
    }
    if (!message) throw new APIError("not_found", "Message not found");
    return message;
  }
  async voice(message: Message) {
    if (message.kind !== "audio")
      throw new APIError("invalid_params", "A voice message is required");
    for (const db of await this.databases()) {
      if (!/^media_\d+\.db$/.test(basename(db.path))) continue;
      const tables = await this.tables(db);
      if (!tables.has("VoiceInfo") || !tables.has("Name2Id")) continue;
      const names = await this.query(
        db,
        "SELECT rowid AS id FROM Name2Id WHERE user_name=" + literal(message.chat_id),
        1,
      );
      if (!names.length) continue;
      const exact = message.id.startsWith("local:")
        ? "local_id=" +
          literal(message.native!.local_id) +
          " AND create_time=" +
          literal(String(message.timestamp))
        : "svr_id=" + literal(message.id);
      const rows = await this.query(
        db,
        "SELECT voice_data,data_index FROM VoiceInfo WHERE chat_name_id=" +
          literal(String(names[0].id)) +
          " AND " +
          exact +
          " ORDER BY data_index",
        128,
      );
      if (!rows.length) continue;
      const chunks = rows.map((r) => Buffer.from(r.voice_data?.base64 || "", "base64"));
      if (chunks.some((b) => !b.length) || chunks.reduce((n, b) => n + b.length, 0) > 1024 * 1024)
        throw new APIError("media_unavailable", "Voice recording is incomplete or too large");
      return Buffer.concat(chunks);
    }
    throw new APIError("media_unavailable", "Voice recording is not downloaded yet");
  }
  private async revoked() {
    const out = new Map<string, Row>();
    for (const d of await this.databases()) {
      if (basename(d.path) !== "general.db" || !(await this.tables(d)).has("revokemessage"))
        continue;
      let after = "0";
      while (true) {
        const page = await this.query(
          d,
          `SELECT *,CAST(rowid AS TEXT) AS __scan_row FROM revokemessage WHERE rowid>${literal(after)} ORDER BY rowid LIMIT 500`,
          500,
        );
        for (const r of page) {
          after = String(r.__scan_row);
          delete r.__scan_row;
          if (r.to_user_name && r.svr_id && String(r.svr_id) !== "0")
            out.set(JSON.stringify([r.to_user_name, r.svr_id, r.revoke_time]), r);
        }
        if (page.length < 500) break;
      }
    }
    return out;
  }
  async bridgeRevocations() {
    return [...(await this.revoked()).values()].map((row) => ({
      chat: String(row.to_user_name),
      id: String(row.svr_id),
    }));
  }
  async changes(scope?: ChangeScope): Promise<Event[]> {
    const same = this.snapshotAccount === this.account();
    if (!this.snapshot || !same) scope = undefined;
    const {
      messages: changed,
      paths,
      scannedPaths,
      scannedTables,
    } = await this.messages(undefined, scope);
    const now = scope ? new Map(this.snapshot) : new Map<string, Message>();
    if (scope)
      for (const [key, message] of now) {
        const path = message.native?.database,
          table = String(message.native?.table || "").toLowerCase();
        if (scannedPaths.has(path) || scannedTables.has(JSON.stringify([path, table])))
          now.delete(key);
      }
    for (const [key, message] of changed) now.set(key, message);
    const revoked =
      !scope || [...scope.keys()].some((path) => basename(path) === "general.db")
        ? await this.revoked()
        : this.revokes;
    const events: Event[] = [];
    if (this.snapshot && same) {
      for (const p of this.paths)
        if (!paths.has(p))
          throw new APIError("not_ready", "A message shard is temporarily unavailable");
      const previousIDs = new Map(
        [...this.snapshot.values()]
          .filter((m) => !m.id.startsWith("local:"))
          .map((m) => [m.chat_id + "\0" + m.id, m]),
      );
      const emitted = new Set<string>();
      for (const [key, m] of scope ? changed : now) {
        const old = this.snapshot.get(key) || previousIDs.get(m.chat_id + "\0" + m.id),
          id = m.chat_id + "\0" + m.id;
        if (JSON.stringify(old) === JSON.stringify(m) || emitted.has(id)) continue;
        events.push({
          type: old ? "message.updated" : "message",
          account_id: this.account(),
          chat_id: m.chat_id,
          message: m,
          ...(old && old.id !== m.id ? { data: { previous_id: old.id } } : {}),
        });
        emitted.add(id);
      }
      const ids = new Set([...now.values()].map((m) => m.chat_id + "\0" + m.id));
      for (const [key, m] of this.snapshot)
        if (!now.has(key) && !ids.has(m.chat_id + "\0" + m.id))
          events.push({
            type: "message.deleted",
            account_id: this.account(),
            chat_id: m.chat_id,
            data: { message_id: m.id, reason: "storage_disappearance" },
          });
      for (const [key, r] of revoked)
        if (!this.revokes.has(key))
          events.push({
            type: "message.revoked",
            account_id: this.account(),
            chat_id: r.to_user_name,
            data: { message_id: String(r.svr_id) },
          });
    }
    this.snapshot = now;
    this.paths = paths;
    this.snapshotAccount = this.account();
    this.revokes = revoked;
    return events;
  }
}
