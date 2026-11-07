import { Database as SQLite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Storage } from "../src/storage";
import type { Database, NativeDB } from "../src/types";

class Fixture implements NativeDB {
  queries: { id: string; sql: string }[] = [];
  connections = new Map<string, SQLite>();
  visible: Database[] = [];
  truncated = false;
  add(name: string, account = "test_self") {
    const db = new SQLite(":memory:", { safeIntegers: true }),
      id = String(this.connections.size + 1);
    this.connections.set(id, db);
    this.visible.push({
      id,
      path: `/fixture/xwechat_files/${account}_1234/db_storage/${name}`,
      encrypted: true,
      readable: true,
    });
    return db;
  }
  async databases() {
    return this.visible;
  }
  async query(id: string, sql: string, limit: number) {
    this.queries.push({ id, sql });
    sql = sql
      .replaceAll("wcdb_decompress(message_content,WCDB_CT_message_content)", "message_content")
      .replaceAll("wcdb_decompress(source,WCDB_CT_source)", "source");
    const stmt = this.connections.get(id)!.query(sql),
      rows = stmt.all() as Record<string, unknown>[];
    const value = (v: unknown) =>
      typeof v === "bigint"
        ? String(v)
        : v instanceof Uint8Array
          ? { base64: Buffer.from(v).toString("base64") }
          : v;
    return {
      columns: stmt.columnNames,
      rows: rows.slice(0, limit).map((row) => stmt.columnNames.map((c) => value(row[c]))),
      truncated: this.truncated || rows.length > limit,
    };
  }
}
function setup() {
  const native = new Fixture(),
    db = native.add("message/message_0.db"),
    chat = "test_friend",
    table = "Msg_" + createHash("md5").update(chat).digest("hex");
  db.run("CREATE TABLE Name2Id(user_name TEXT,is_session INTEGER)");
  db.run("INSERT INTO Name2Id VALUES('test_friend',1),('test_self',1)");
  db.run(
    "CREATE TABLE " +
      table +
      "(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT,WCDB_CT_message_content INTEGER)",
  );
  const store = new Storage(native, () => "test_self");
  const insert = (local: number, server: bigint, text = "hello", kind = 1) =>
    db.run("INSERT INTO " + table + " VALUES(?,?,?,2,100,?,0)", [local, server, kind, text]);
  return { native, db, chat, table, store, insert };
}
test("native IDs remain exact and history identifies own messages", async () => {
  const { store, chat, insert } = setup();
  insert(1, 9223372036854775806n);
  const page = await store.history({ chat_id: chat });
  expect(page.messages[0].id).toBe("9223372036854775806");
  expect(page.messages[0].own).toBe(true);
  expect(page.messages[0].text).toBe("hello");
});
test("account switches isolate retained databases and history", async () => {
  const { native, chat, table, insert } = setup();
  insert(1, 101n, "previous account");
  const db = native.add("message/message_0.db", "next_self");
  db.run("CREATE TABLE Name2Id(user_name TEXT,is_session INTEGER)");
  db.run("INSERT INTO Name2Id VALUES('test_friend',1),('next_self',1)");
  db.run(
    "CREATE TABLE " +
      table +
      "(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT,WCDB_CT_message_content INTEGER)",
  );
  db.run("INSERT INTO " + table + " VALUES(1,202,1,2,100,'current account',0)");
  let account = "test_self";
  const store = new Storage(native, () => account);
  expect((await store.history({ chat_id: chat })).messages.map((m) => m.text)).toEqual([
    "previous account",
  ]);
  account = "next_self";
  expect((await store.history({ chat_id: chat })).messages).toMatchObject([
    { id: "202", text: "current account", account_id: "next_self" },
  ]);
  account = "";
  await expect(store.history({ chat_id: chat })).rejects.toMatchObject({ code: "not_ready" });
});
test("native app subtype 62 tickles render the client title as a read-only system message", async () => {
  const { store, chat, insert } = setup();
  insert(
    1,
    9007199254740999n,
    "<msg><appmsg><type>62</type><title>I tickled Friend &amp; Co</title><patinfo><fromusername>test_self</fromusername><pattedusername>test_friend</pattedusername></patinfo></appmsg></msg>",
    49,
  );
  const message = (await store.history({ chat_id: chat })).messages[0];
  expect(message.kind).toBe("system");
  expect(message.text).toBe("I tickled Friend & Co");
  expect(message.own).toBe(true);
});
test("payment system XML becomes a read-only notice without native action metadata", async () => {
  const { store, chat, insert } = setup();
  insert(
    1,
    303n,
    '<?xml version="1.0"?><sysmsg type="paymsg"><content><![CDATA[你有一笔待接收的<_wc_custom_link_ href="weixin://wxpay/transfer/remindrcvmsg?transferid=private-id">转账</_wc_custom_link_>]]></content></sysmsg>',
    10000,
  );
  const message = (await store.history({ chat_id: chat })).messages[0];
  expect(message).toMatchObject({
    kind: "system",
    read_only: true,
    system: { type: "payment_reminder" },
    text: "你有一笔待接收的转账",
  });
  expect(message.text).not.toContain("weixin:");
});
test("initial history is not replayed as live events; inserts and ID changes are emitted once", async () => {
  const { store, db, table, insert } = setup();
  expect(await store.changes()).toEqual([]);
  insert(1, 0n);
  const add = await store.changes();
  expect(add[0].type).toBe("message");
  const local = add[0].message!.id;
  db.run("UPDATE " + table + " SET server_id=9223372036854775806");
  const change = await store.changes();
  expect(change[0].type).toBe("message.updated");
  expect(change[0].data?.previous_id).toBe(local);
  expect(await store.changes()).toEqual([]);
});
test("truncated reads and unavailable shards cannot become deletions", async () => {
  const { store, native, insert } = setup();
  insert(1, 5n);
  await store.changes();
  native.truncated = true;
  await expect(store.changes()).rejects.toMatchObject({ code: "scan_limit" });
  native.truncated = false;
  native.visible = [];
  await expect(store.changes()).rejects.toMatchObject({ code: "not_ready" });
});
test("empty message database is a valid empty history", async () => {
  const { store, native, db, table, chat } = setup();
  db.run("DROP TABLE " + table);
  store.invalidate();
  expect((await store.history({ chat_id: chat })).messages).toEqual([]);
  native.visible = [];
  await expect(store.history({ chat_id: chat })).rejects.toMatchObject({
    code: "not_ready",
  });
});
test("history cursors, replies, locations and packed file types", async () => {
  const { store, chat, insert } = setup();
  insert(1, 101n, "first");
  insert(
    2,
    102n,
    "<msg><appmsg><type>57</type><title>reply</title><refermsg><svrid>9223372036854775806</svrid></refermsg></appmsg></msg>",
    49 + 57 * 4294967296,
  );
  insert(3, 103n, '<msg><location x="40" y="-73" label="Place"/></msg>', 48);
  insert(4, 104n, "<msg><appmsg><type>6</type></appmsg></msg>", 49 + 6 * 4294967296);
  const page = await store.history({ chat_id: chat, limit: 2 });
  expect(page.messages.map((m) => m.id)).toEqual(["104", "103"]);
  expect(page.messages[0].kind).toBe("file");
  expect(page.messages[1].location?.longitude).toBe(-73);
  const next = await store.history({ chat_id: chat, cursor: page.next_cursor });
  expect(next.messages[0].reply_to).toBe("9223372036854775806");
  await expect(store.history({ chat_id: chat, cursor: "bad" })).rejects.toMatchObject({
    code: "invalid_params",
  });
});
test("contacts, group roster, announcements and conversations use actual joins", async () => {
  const { native, store } = setup(),
    contact = native.add("contact/contact.db");
  contact.run("CREATE TABLE contact(id INTEGER,username TEXT,nick_name TEXT,remark TEXT)");
  contact.run(
    "INSERT INTO contact VALUES(1,'test_friend','Friend',''),(2,'test@chatroom','Group',''),(3,'test_self','Self','')",
  );
  contact.run("CREATE TABLE chat_room(id INTEGER,username TEXT)");
  contact.run("INSERT INTO chat_room VALUES(10,'test@chatroom')");
  contact.run("CREATE TABLE chatroom_member(room_id INTEGER,member_id INTEGER)");
  contact.run("INSERT INTO chatroom_member VALUES(10,1)");
  contact.run("CREATE TABLE chat_room_info_detail(username_ TEXT,announcement_ TEXT)");
  contact.run("INSERT INTO chat_room_info_detail VALUES('test@chatroom','Announcement')");
  const groups = await store.groups();
  expect(groups.groups[0].joined).toBe(false);
  contact.run("INSERT INTO chatroom_member VALUES(10,3)");
  expect((await store.groups()).groups[0].joined).toBe(true);
  expect(groups.groups[0].members?.[0].id).toBe("test_friend");
  expect(groups.groups[0].topic).toBe("Announcement");
  const sessions = native.add("session/session.db");
  sessions.run(
    "CREATE TABLE SessionTable(username TEXT,unread_count INTEGER,last_timestamp INTEGER,is_hidden INTEGER)",
  );
  sessions.run("INSERT INTO SessionTable VALUES('test@chatroom',3,100,0)");
  expect((await store.conversations()).conversations[0]).toMatchObject({
    chat_type: "group",
    unread_count: 3,
  });
});
test("profile pictures are read from the native cache with quoted usernames", async () => {
  const { native, store } = setup(),
    db = native.add("head_image/head_image.db"),
    name = "test'avatar";
  db.run("CREATE TABLE head_image(username TEXT,image_buffer BLOB,update_time INTEGER)");
  const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  db.run("INSERT INTO head_image VALUES(?,?,1)", [name, image]);
  expect([...(await store.avatar(name))]).toEqual([...image]);
  await expect(store.avatar("missing' OR 1=1 --")).rejects.toMatchObject({
    code: "not_found",
  });
});
test("voice chunks join the media shard chat mapping, preserve exact IDs, and exclude another chat", async () => {
  const { native, store, chat, insert } = setup();
  insert(1, 9223372036854775806n, "<msg/>", 34);
  const db = native.add("message/media_0.db");
  db.run("CREATE TABLE Name2Id(user_name TEXT)");
  db.run("INSERT INTO Name2Id VALUES('other_chat'),('test_friend')");
  db.run(
    "CREATE TABLE VoiceInfo(chat_name_id INTEGER,create_time INTEGER,local_id INTEGER,svr_id INTEGER,voice_data BLOB,data_index INTEGER)",
  );
  db.run("INSERT INTO VoiceInfo VALUES(1,100,1,9223372036854775806,?,0)", [
    Buffer.from("wrong chat"),
  ]);
  for (const [index, value] of [
    [1, "second"],
    [0, "first"],
  ] as const)
    db.run("INSERT INTO VoiceInfo VALUES(2,100,1,9223372036854775806,?,?)", [
      Buffer.from(value),
      index,
    ]);
  const message = (await store.history({ chat_id: chat })).messages[0];
  expect((await store.voice(message)).toString()).toBe("firstsecond");
  await expect(store.voice({ ...message, chat_id: "missing' OR 1=1 --" })).rejects.toMatchObject({
    code: "media_unavailable",
  });
});
test("bridge keyset history crosses 50,000 rows and resumes equal timestamps across shards", async () => {
  const { native, store, chat, table, db } = setup();
  const insert = db.prepare("INSERT INTO " + table + " VALUES(?,?,1,2,100,?,0)");
  db.transaction(() => {
    for (let i = 1; i <= 50001; i++) insert.run(i, BigInt(i), "row " + i);
  })();
  const second = native.add("message/message_1.db");
  second.run("CREATE TABLE Name2Id(user_name TEXT,is_session INTEGER)");
  second.run("INSERT INTO Name2Id VALUES('test_friend',1),('test_self',1)");
  second.run(
    "CREATE TABLE " +
      table +
      "(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT,WCDB_CT_message_content INTEGER)",
  );
  second.run("INSERT INTO " + table + " VALUES(1,9223372036854775806,1,2,100,'other shard',0)");
  let cursor: string | undefined,
    count = 0;
  const ids = new Set<string>();
  while (true) {
    const page = await store.bridgeHistory(chat, cursor, 500);
    for (const message of page.messages) {
      ids.add(message.id);
      count++;
    }
    cursor = page.cursor;
    if (page.done) break;
  }
  expect(count).toBe(50002);
  expect(ids.size).toBe(50002);
  expect((await store.bridgeHistory(chat, cursor, 500)).messages).toHaveLength(0);
  expect((await store.message(chat, "9223372036854775806")).text).toBe("other shard");
  await expect(store.bridgeHistory("other", cursor)).rejects.toMatchObject({
    code: "invalid_params",
  });
  native.truncated = true;
  await expect(store.bridgeHistory(chat)).rejects.toMatchObject({ code: "scan_limit" });
});

test("schema cache survives message writes and discovers DDL in an open database", async () => {
  const { native, store, db, insert } = setup();
  const source = native.visible[0];
  const first = await store.tables(source);
  native.queries.length = 0;
  insert(1, 101n);
  expect(await store.tables(source)).toBe(first);
  expect(native.queries.map((q) => q.sql)).toEqual(["PRAGMA schema_version"]);
  db.run("CREATE TABLE newly_created(value TEXT)");
  expect((await store.tables(source)).has("newly_created")).toBe(true);
});

test("dirty-table snapshots preserve old edits, ID promotion, deletion and untouched conversations", async () => {
  const { native, store, db, table, insert } = setup();
  const other = "Msg_" + createHash("md5").update("other_friend").digest("hex");
  db.run("INSERT INTO Name2Id VALUES('other_friend',1)");
  db.run(`CREATE TABLE ${other} AS SELECT * FROM ${table}`);
  insert(1, 0n, "pending");
  insert(2, 102n, "deleted");
  db.run(`INSERT INTO ${other} VALUES(1,201,1,2,100,'untouched',0)`);
  await store.changes();
  db.run(`UPDATE ${table} SET server_id=101,message_content='edited' WHERE local_id=1`);
  db.run(`DELETE FROM ${table} WHERE local_id=2`);
  native.queries.length = 0;
  const events = await store.changes(
    new Map([[native.visible[0].path, new Set([table.toLowerCase()])]]),
  );
  expect(
    events.some(
      (e) =>
        e.type === "message.updated" &&
        e.message?.id === "101" &&
        e.message.text === "edited" &&
        e.data?.previous_id?.startsWith("local:"),
    ),
  ).toBe(true);
  expect(events.some((e) => e.type === "message.deleted" && e.data?.message_id === "102")).toBe(
    true,
  );
  expect(events.some((e) => e.chat_id === "other_friend")).toBe(false);
  expect(native.queries.some((q) => q.sql.includes(`FROM "${other}" WHERE local_id`))).toBe(false);
  db.run(`UPDATE ${other} SET message_content='recovered'`);
  expect((await store.changes()).some((e) => e.message?.text === "recovered")).toBe(true);
});

test("trigger writes widen dirty snapshots and failed partial scans preserve the previous snapshot", async () => {
  const { native, store, db, table, insert } = setup();
  const other = "Msg_" + createHash("md5").update("other_friend").digest("hex");
  db.run("INSERT INTO Name2Id VALUES('other_friend',1)");
  db.run(`CREATE TABLE ${other} AS SELECT * FROM ${table}`);
  db.run(
    `CREATE TRIGGER mirror AFTER INSERT ON ${table} BEGIN INSERT INTO ${other} SELECT * FROM ${table} WHERE local_id=new.local_id; END`,
  );
  await store.changes();
  insert(1, 101n);
  const scope = new Map([[native.visible[0].path, new Set([table.toLowerCase()])]]);
  native.truncated = true;
  await expect(store.changes(scope)).rejects.toMatchObject({ code: "scan_limit" });
  native.truncated = false;
  const events = await store.changes(scope);
  expect(events.filter((e) => e.type === "message")).toHaveLength(2);
  expect(await store.changes(scope)).toEqual([]);
});
