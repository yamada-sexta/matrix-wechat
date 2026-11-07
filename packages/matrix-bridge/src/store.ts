import { Database } from "bun:sqlite";
import { publicFields } from "wechat-rpc";
import type { Message } from "./messages";

export function hash(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
export interface Portal {
  account: string;
  chat: string;
  room: string;
  cursor: string | null;
  imported: number;
  metadata: string;
}
export interface Mapping {
  account: string;
  chat: string;
  id: string;
  local: string | null;
  event: string;
  sender: string;
  fingerprint: string;
  payload: string;
  media_retry: number;
  redacted: number;
}
export interface MatrixEvent {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  state_key?: string;
  content: Record<string, any>;
  origin_server_ts?: number;
}
export interface Inbox {
  id: string;
  payload: string;
  state: "queued" | "sending" | "submitted" | "uncertain" | "delivered" | "done" | "failed";
  account: string;
  chat: string;
  fingerprint: string;
  baseline: string;
  started: number;
  notice: number;
}

export class Store {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    const version = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (version > 1) {
      this.db.close();
      throw new Error("Bridge database schema is newer than this executable");
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portals(account TEXT NOT NULL,chat TEXT NOT NULL,room TEXT NOT NULL UNIQUE,cursor TEXT,imported INTEGER NOT NULL DEFAULT 0,metadata TEXT NOT NULL DEFAULT '',PRIMARY KEY(account,chat));
      CREATE TABLE IF NOT EXISTS ghosts(account TEXT NOT NULL,id TEXT NOT NULL,mxid TEXT NOT NULL UNIQUE,profile TEXT NOT NULL DEFAULT '',PRIMARY KEY(account,id));
      CREATE TABLE IF NOT EXISTS messages(account TEXT NOT NULL,chat TEXT NOT NULL,id TEXT NOT NULL,local TEXT,event TEXT NOT NULL,sender TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,media_retry INTEGER NOT NULL DEFAULT 0,redacted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,chat,id));
      CREATE INDEX IF NOT EXISTS messages_local ON messages(account,chat,local);
      CREATE INDEX IF NOT EXISTS messages_event ON messages(event);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',account TEXT NOT NULL DEFAULT '',chat TEXT NOT NULL DEFAULT '',fingerprint TEXT NOT NULL DEFAULT '',baseline TEXT NOT NULL DEFAULT '[]',started INTEGER NOT NULL DEFAULT 0,notice INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS incoming(key TEXT PRIMARY KEY,account TEXT NOT NULL,chat TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revocations(account TEXT NOT NULL,chat TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(account,chat,id));
      CREATE TABLE IF NOT EXISTS uploads(key TEXT PRIMARY KEY,mxc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dirty_chats(account TEXT NOT NULL,chat TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(account,chat));
      PRAGMA user_version=1;
    `);
    // A native operation may have happened before the process stopped. Never resend it.
    this.db.run("UPDATE inbox SET state='uncertain' WHERE state='sending'");
  }
  get<T>(sql: string, ...params: (string | number | null)[]): T | null {
    return this.db.query<T, (string | number | null)[]>(sql).get(...params);
  }
  all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.query<T, (string | number | null)[]>(sql).all(...params);
  }
  run(sql: string, ...params: (string | number | null)[]) {
    return this.db.run(sql, params);
  }
  meta(key: string) {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key=?", key)?.value;
  }
  setMeta(key: string, value: string) {
    this.run(
      "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
  }
  revision(key: string, signature: string) {
    const previous = JSON.parse(this.meta(`revision:${key}`) || "null") as {
      signature: string;
      sequence: number;
    } | null;
    if (previous?.signature === signature) return previous.sequence;
    const sequence = (previous?.sequence || 0) + 1;
    this.setMeta(`revision:${key}`, JSON.stringify({ signature, sequence }));
    return sequence;
  }
  portal(account: string, chat: string) {
    return this.get<Portal>("SELECT * FROM portals WHERE account=? AND chat=?", account, chat);
  }
  dirtyChat(account: string, chat: string) {
    this.run(
      "INSERT INTO dirty_chats VALUES(?,?,1) ON CONFLICT(account,chat) DO UPDATE SET revision=revision+1",
      account,
      chat,
    );
  }
  dirtyChats(account: string) {
    return this.all<{ chat: string; revision: number }>(
      "SELECT chat,revision FROM dirty_chats WHERE account=?",
      account,
    );
  }
  cleanChat(account: string, chat: string, revision: number) {
    this.run(
      "DELETE FROM dirty_chats WHERE account=? AND chat=? AND revision=? AND NOT EXISTS(SELECT 1 FROM incoming WHERE account=? AND chat=?)",
      account,
      chat,
      revision,
      account,
      chat,
    );
  }
  portalForRoom(room: string) {
    return this.get<Portal>("SELECT * FROM portals WHERE room=?", room);
  }
  portals(account: string) {
    return this.all<Portal>("SELECT * FROM portals WHERE account=? ORDER BY chat", account);
  }
  addPortal(account: string, chat: string, room: string) {
    this.run("INSERT OR IGNORE INTO portals(account,chat,room) VALUES(?,?,?)", account, chat, room);
  }
  progress(account: string, chat: string, cursor: string, done: boolean) {
    this.run(
      "UPDATE portals SET cursor=?,imported=? WHERE account=? AND chat=?",
      cursor,
      Number(done),
      account,
      chat,
    );
  }
  mapping(account: string, chat: string, id: string, local?: string) {
    return this.get<Mapping>(
      "SELECT * FROM messages WHERE account=? AND chat=? AND (id=? OR (local IS NOT NULL AND local=?)) ORDER BY id=? DESC LIMIT 1",
      account,
      chat,
      id,
      local || null,
      id,
    );
  }
  eventMapping(account: string, chat: string, event: string) {
    return this.get<Mapping>(
      "SELECT * FROM messages WHERE account=? AND chat=? AND event=? ORDER BY id LIKE 'local:%' LIMIT 1",
      account,
      chat,
      event,
    );
  }
  saveMapping(
    message: Message,
    event: string,
    sender: string,
    fingerprint: string,
    mediaRetry = false,
  ) {
    this.run(
      `INSERT INTO messages(account,chat,id,local,event,sender,fingerprint,payload,media_retry) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account,chat,id) DO UPDATE SET local=excluded.local,event=excluded.event,sender=excluded.sender,fingerprint=excluded.fingerprint,payload=excluded.payload,media_retry=excluded.media_retry`,
      message.account_id,
      message.chat_id,
      message.id,
      message.local_key || null,
      event,
      sender,
      fingerprint,
      JSON.stringify(publicFields(message)),
      Number(mediaRetry),
    );
  }
  accept(event: MatrixEvent) {
    this.run(
      "INSERT OR IGNORE INTO inbox(id,payload) VALUES(?,?)",
      event.event_id,
      JSON.stringify(event),
    );
  }
  queued(management = "", prefix = "") {
    return this.all<Inbox>(
      `SELECT * FROM inbox WHERE state='queued'
       ORDER BY CASE WHEN json_extract(payload,'$.type')='m.room.message' AND
         (json_extract(payload,'$.room_id')=? OR
          (?<>'' AND instr(json_extract(payload,'$.content.body'),?)=1))
         THEN 0 ELSE 1 END, rowid LIMIT 100`,
      management,
      prefix,
      prefix,
    );
  }
  pending(account: string, chat?: string) {
    return this.all<Inbox>(
      "SELECT * FROM inbox WHERE account=? AND (? IS NULL OR chat=?) AND state IN ('sending','submitted','uncertain') ORDER BY rowid",
      account,
      chat || null,
      chat || null,
    );
  }
  queue(message: Message) {
    const key = hash(
      JSON.stringify([message.account_id, message.chat_id, message.local_key || message.id]),
    );
    this.run(
      "INSERT INTO incoming VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
      key,
      message.account_id,
      message.chat_id,
      JSON.stringify(publicFields(message)),
    );
    this.dirtyChat(message.account_id, message.chat_id);
  }
  close() {
    this.db.close();
  }
}
