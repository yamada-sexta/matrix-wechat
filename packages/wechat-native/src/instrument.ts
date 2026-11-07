import { CommittedWrites, transactionEnd, type WriteScope, writeScope } from "./changes";
import { createDownloader } from "./download";
import { createQueryBatch } from "./query";
import { createSession } from "./session";
import { createUploadHooks } from "./uploads";

/* Injected into the exact pinned WeChat image. Keys remain in target memory. */

const base = Process.mainModule.base;
const nullPtr = ptr(0);
const imageDownloads = createDownloader();
const queryBatch = createQueryBatch();
interface DatabaseConnection {
  id: string;
  db: NativePointer;
  path: string;
  key: NativePointer | null;
  keyLength: number;
  cipher: string[];
  reader: NativePointer | null;
  readable: boolean;
  error: string | null;
}
interface PreparedStatement {
  connection: DatabaseConnection;
  write: boolean;
  cipher: string | null;
  transactionEnd: boolean;
  scope: WriteScope;
}
type OpenInvocation = InvocationContext & { output?: NativePointer; path?: string };
type PrepareInvocation = InvocationContext & {
  db?: NativePointer;
  output?: NativePointer;
  cipher?: string | null;
  transactionEnd?: boolean;
  scope?: WriteScope;
};
type StepInvocation = InvocationContext & { statement?: PreparedStatement };
type CloseInvocation = InvocationContext & { dbId?: string; connection?: DatabaseConnection };
interface StdString {
  object: NativePointer;
  bytes: NativePointer;
}
interface NativeSendResult {
  success: boolean;
  error_message?: string;
  message_id?: string;
  create_time?: string;
}
interface PendingSend {
  resolve: (value: NativeSendResult) => void;
  reject: (reason: unknown) => void;
  args: StdString;
  context: StdString;
  callback: NativePointer;
  owner: NativePointer;
}
interface QuoteReference {
  id: string;
  local_id: number;
  content: string;
  sender: string;
  name: string;
  type: number;
  timestamp: number;
}
type SendTrace =
  | { entry: string; sql: string; callers: string[] }
  | {
      entry: string;
      vtable: string;
      bytes: string;
      strings: { offset: number; value: string }[];
      callers: string[];
    }
  | { error: string };

const connections = new Map<string, DatabaseConnection>(),
  retained = new Map<string, DatabaseConnection>(),
  statements = new Map<string, PreparedStatement>(),
  internalHandles = new Set<string>();
let connectionSequence = 0;
const internalThreads = new Map<number, number>();
function enterInternal() {
  const tid = Process.getCurrentThreadId();
  internalThreads.set(tid, (internalThreads.get(tid) || 0) + 1);
}
function leaveInternal() {
  const tid = Process.getCurrentThreadId();
  const n = (internalThreads.get(tid) || 1) - 1;
  if (n) internalThreads.set(tid, n);
  else internalThreads.delete(tid);
}
let revision = 0;
const signatures = {
  libversion: ["pointer", []],
  open_v2: ["int", ["pointer", "pointer", "int", "pointer"]],
  close_v2: ["int", ["pointer"]],
  prepare_v2: ["int", ["pointer", "pointer", "int", "pointer", "pointer"]],
  prepare_v3: ["int", ["pointer", "pointer", "int", "uint", "pointer", "pointer"]],
  step: ["int", ["pointer"]],
  finalize: ["int", ["pointer"]],
  reset: ["int", ["pointer"]],
  db_handle: ["pointer", ["pointer"]],
  get_autocommit: ["int", ["pointer"]],
  db_filename: ["pointer", ["pointer", "pointer"]],
  db_mutex: ["pointer", ["pointer"]],
  mutex_enter: ["void", ["pointer"]],
  mutex_leave: ["void", ["pointer"]],
  column_count: ["int", ["pointer"]],
  column_name: ["pointer", ["pointer", "int"]],
  column_type: ["int", ["pointer", "int"]],
  column_int64: ["int64", ["pointer", "int"]],
  column_double: ["double", ["pointer", "int"]],
  column_text: ["pointer", ["pointer", "int"]],
  column_blob: ["pointer", ["pointer", "int"]],
  column_bytes: ["int", ["pointer", "int"]],
  errmsg: ["pointer", ["pointer"]],
  stmt_readonly: ["int", ["pointer"]],
  key: ["int", ["pointer", "pointer", "int"]],
  key_v2: ["int", ["pointer", "pointer", "pointer", "int"]],
  create_function: [
    "int",
    ["pointer", "pointer", "int", "int", "pointer", "pointer", "pointer", "pointer"],
  ],
} as const satisfies Record<
  string,
  readonly [NativeFunctionReturnType, readonly NativeFunctionArgumentType[]]
>;
type SqliteSignatures = typeof signatures;
type SqliteFunctions = {
  [Name in keyof SqliteSignatures]: NativeFunction<
    GetNativeFunctionReturnValue<SqliteSignatures[Name][0]>,
    Extract<
      GetNativeFunctionArgumentValue<[...SqliteSignatures[Name][1]]>,
      NativeFunctionArgumentValue[]
    >
  >;
};
// Object.entries loses the correlation between each function name and its ABI tuple.
// The assertion is confined to constructing the table from those exact tuples.
const native = Object.fromEntries(
  Object.entries(signatures).map(([name, sig]) => {
    const address = base.add(PROFILE.functions[name]);
    const expected = PROFILE.validation_bytes[name];
    if (expected) {
      const actual = Array.from(new Uint8Array(readBytes(address, expected.length / 2)))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      if (actual !== expected) throw Error("Unsupported native function bytes: " + name);
    }
    return [
      name,
      new NativeFunction(address, sig[0], [...sig[1]], {
        exceptions: "steal",
      }),
    ];
  }),
) as SqliteFunctions;
function readBytes(pointer: NativePointer, length: number): ArrayBuffer {
  const bytes = pointer.readByteArray(length);
  if (bytes === null) throw Error("Cannot read bytes from a null pointer");
  return bytes;
}
function text(p: NativePointer): string {
  return p.isNull() ? "" : p.readUtf8String() || "";
}
function hint(kind: string, data: Record<string, unknown>) {
  revision++;
  send({ type: "change_hint", kind, revision, ...data });
}
const committedWrites = new CommittedWrites((change) =>
  hint("committed_write", change as unknown as Record<string, unknown>),
);
function recognized(path: string) {
  return (
    /\/db_storage\//.test(path) &&
    /\.db$/.test(path) &&
    !/\/(sns|favorite|solitaire|chatbot|third_app_icon)\//.test(path) &&
    !/(?:_fts|weclaw)\.db$/.test(path)
  );
}
function discover(db: NativePointer, path?: string): DatabaseConnection | null {
  if (db.isNull() || internalHandles.has(db.toString())) return null;
  const id = db.toString();
  let c = connections.get(id);
  if (!path) {
    try {
      path = text(native.db_filename(db, Memory.allocUtf8String("main")));
    } catch (_) {
      return null;
    }
  }
  if (!recognized(path)) return null;
  if (!c) {
    c = {
      id: id + "#" + ++connectionSequence,
      db,
      path,
      key: null,
      keyLength: 0,
      cipher: [],
      reader: null,
      readable: false,
      error: null,
    };
    connections.set(id, c);
    hint("database_open", { id, path });
  }
  return c;
}
function closeReader(c: DatabaseConnection) {
  if (c.reader) {
    const p = c.reader;
    c.reader = null;
    enterInternal();
    try {
      native.close_v2(p);
    } finally {
      leaveInternal();
      internalHandles.delete(p.toString());
    }
  }
}
for (const name of ["open_v2", "open"]) {
  if (!PROFILE.functions[name]) continue;
  Interceptor.attach(base.add(PROFILE.functions[name]), {
    onEnter(this: OpenInvocation, a) {
      if (internalThreads.has(this.threadId)) return;
      this.output = a[1];
      this.path = text(a[0]);
    },
    onLeave(this: OpenInvocation, ret) {
      if (this.output && ret.toInt32() === 0) discover(this.output.readPointer(), this.path);
    },
  });
}
for (const name of ["key", "key_v2"])
  Interceptor.attach(base.add(PROFILE.functions[name]), {
    onEnter(a) {
      if (internalThreads.has(this.threadId)) return;
      const c = discover(a[0]);
      if (!c) return;
      const k = name === "key" ? 1 : 2,
        n = k + 1;
      const length = a[n].toInt32();
      if (length > 0 && length <= 1024) {
        if (c.key) c.key.writeByteArray(new ArrayBuffer(c.keyLength));
        c.key = Memory.alloc(length);
        c.key.writeByteArray(readBytes(a[k], length));
        c.keyLength = length;
        closeReader(c);
        hint("database_configured", { id: c.id, path: c.path });
      }
    },
  });
for (const name of ["prepare_v2", "prepare_v3"])
  Interceptor.attach(base.add(PROFILE.functions[name]), {
    onEnter(this: PrepareInvocation, a) {
      if (internalThreads.has(this.threadId)) return;
      this.db = a[0];
      this.output = a[name === "prepare_v2" ? 3 : 4];
      let sql = "";
      try {
        sql = text(a[1]);
      } catch (_) {}
      if (traceSends && sendTraces.length < 64 && /^\s*(INSERT|REPLACE)\b[\s\S]*\bMsg_/i.test(sql))
        sendTraces.push({
          entry: "database_message_insert",
          sql: sql.slice(0, 200),
          callers: Thread.backtrace(this.context, Backtracer.ACCURATE).map((p) =>
            p.sub(base).toString(),
          ),
        });
      this.transactionEnd = transactionEnd(sql);
      this.scope = writeScope(sql);
      this.cipher = sql.match(
        /^\s*PRAGMA\s+(cipher_[a-z_]+|kdf_iter|fast_kdf_iter)\s*=\s*([a-zA-Z0-9_'"-]+)\s*;?\s*$/i,
      )
        ? sql
        : null;
    },
    onLeave(this: PrepareInvocation, ret) {
      if (!this.output || !this.db || ret.toInt32() !== 0) return;
      const c = discover(this.db);
      if (!c) return;
      const statement = this.output.readPointer();
      if (!statement.isNull()) {
        statements.set(statement.toString(), {
          connection: c,
          write: !native.stmt_readonly(statement),
          cipher: this.cipher ?? null,
          transactionEnd: this.transactionEnd === true,
          scope: this.scope || {},
        });
      }
    },
  });
Interceptor.attach(base.add(PROFILE.functions.step), {
  onEnter(this: StepInvocation, a) {
    if (internalThreads.has(this.threadId)) return;
    this.statement = statements.get(a[0].toString());
  },
  onLeave(this: StepInvocation, ret) {
    const s = this.statement;
    if (!s) return;
    const rc = ret.toInt32();
    if (rc === 101 && s.cipher && !s.connection.cipher.includes(s.cipher)) {
      s.connection.cipher.push(s.cipher);
      closeReader(s.connection);
    }
    if ((s.write || s.transactionEnd) && rc === 101) {
      let committed = false;
      try {
        committed = native.get_autocommit(s.connection.db) !== 0;
      } catch (_) {}
      if (s.write && !s.transactionEnd)
        committedWrites.record(s.connection.id, s.connection.path, s.scope);
      if (committed) committedWrites.commit(s.connection.id);
    }
  },
});
Interceptor.attach(base.add(PROFILE.functions.finalize), {
  onEnter(a) {
    if (!internalThreads.has(this.threadId)) statements.delete(a[0].toString());
  },
});
for (const name of ["close", "close_v2"])
  Interceptor.attach(base.add(PROFILE.functions[name]), {
    onEnter(this: CloseInvocation, a) {
      if (internalThreads.has(this.threadId)) return;
      this.dbId = a[0].toString();
      this.connection = connections.get(this.dbId);
    },
    onLeave(this: CloseInvocation, ret) {
      if (!this.dbId) return;
      if (this.connection && ret.toInt32() === 0) {
        const old = retained.get(this.connection.path);
        if (old && old !== this.connection) {
          closeReader(old);
          if (old.key) old.key.writeByteArray(new ArrayBuffer(old.keyLength));
        }
        retained.set(this.connection.path, this.connection);
        connections.delete(this.dbId);
        committedWrites.forget(this.connection.id);
        hint("database_closed", { id: this.connection.id, path: this.connection.path });
      }
    },
  });
const session = createSession((kind) => {
  imageDownloads.invalidate();
  hint(kind, {});
});
let previousLogin: boolean | undefined;
function sessionState() {
  const state = session.status();
  if (previousLogin !== undefined && previousLogin !== state.logged_in) imageDownloads.invalidate();
  previousLogin = state.logged_in;
  return state;
}
function accountMatches(account: string) {
  const accounts = new Set(
    [...connections.values()]
      .map((c) => c.path.match(/\/xwechat_files\/([^/]+)_[a-f0-9]{4}\/db_storage\//i)?.[1])
      .filter(Boolean),
  );
  return accounts.size === 1 && accounts.has(account);
}
function sqlQuery(db: NativePointer, sql: string, maxRows: number, allowWrite = false) {
  return queryBatch.query(db, sql, maxRows, allowWrite);
}
function reader(c: DatabaseConnection): NativePointer {
  if (c.reader) return c.reader;
  const out = Memory.alloc(Process.pointerSize);
  out.writePointer(nullPtr);
  const rc = native.open_v2(Memory.allocUtf8String(c.path), out, 0x10001, nullPtr);
  const db = out.readPointer();
  if (rc !== 0) {
    if (!db.isNull()) native.close_v2(db);
    throw Error("Read-only open failed: " + rc);
  }
  internalHandles.add(db.toString());
  try {
    if (c.key) {
      const kr = native.key(db, c.key, c.keyLength);
      if (kr !== 0) throw Error("Native cipher setup failed: " + kr);
    }
    for (const pragma of c.cipher) sqlQuery(db, pragma, 1, true);
    const compression = PROFILE.compression;
    if (compression) {
      const cr = native.create_function(
        db,
        Memory.allocUtf8String(compression.scalar_name),
        compression.argument_count,
        compression.sqlite_encoding_flags,
        nullPtr,
        base.add(compression.scalar_callback_rva),
        nullPtr,
        nullPtr,
      );
      if (cr !== 0) throw Error("Native decompression registration failed: " + cr);
    }
    sqlQuery(db, "SELECT name FROM sqlite_master LIMIT 1", 1);
    c.reader = db;
    c.readable = true;
    c.error = null;
    return db;
  } catch (e) {
    internalHandles.delete(db.toString());
    native.close_v2(db);
    c.readable = false;
    c.error = String(e);
    throw e;
  }
}
function scanQR() {
  const candidates = [];
  let bytesScanned = 0;
  for (const range of Process.enumerateRanges({
    protection: "rw-",
    coalesce: true,
  })) {
    if (
      range.size > 100 * 1024 * 1024 ||
      range.size < 512 ||
      (range.file && !range.file.path.includes("wechat"))
    )
      continue;
    bytesScanned += range.size;
    let hits: MemoryScanMatch[] = [];
    try {
      hits = Memory.scanSync(range.base, range.size, "89 50 4e 47 0d 0a 1a 0a");
    } catch (_) {}
    for (const hit of hits) {
      try {
        const p = hit.address;
        const width =
          ((p.add(16).readU8() << 24) |
            (p.add(17).readU8() << 16) |
            (p.add(18).readU8() << 8) |
            p.add(19).readU8()) >>>
          0;
        const height =
          ((p.add(20).readU8() << 24) |
            (p.add(21).readU8() << 16) |
            (p.add(22).readU8() << 8) |
            p.add(23).readU8()) >>>
          0;
        if (width !== height || width < 64 || width > 1024) continue;
        const n = Math.min(256000, range.size - p.sub(range.base).toUInt32());
        const end = Memory.scanSync(p, n, "49 45 4e 44 ae 42 60 82");
        if (end.length) {
          const length = end[0].address.sub(p).toUInt32() + 8;
          candidates.push({
            bytes: Array.from(new Uint8Array(readBytes(p, length))),
            width,
            height,
          });
        }
      } catch (_) {}
    }
  }
  return { candidates, bytes_scanned: bytesScanned };
}
// Executed inside Frida; input and callback lifetimes are retained explicitly.
const outboundPending = new Map<string, PendingSend>();
let outboundSequence = 0;
const outboundQueue: ((context: NativePointer) => void)[] = [];
let drainingOutbound = false;
// Outbound wrappers require the native worker's thread-local account context;
// Qt's GUI thread cannot send. Probe the factory's validated epilogue after its
// output is initialized. A true instruction probe does not replace the return
// address or leave a Frida invocation frame across native coroutine switches.
const accountReady = base.add(0x6042244),
  accountReadyBytes = "4889d84883c4185b415ec3";
if (
  Array.from(new Uint8Array(readBytes(accountReady, accountReadyBytes.length / 2)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("") !== accountReadyBytes
)
  throw Error("Unsupported native account dispatch epilogue");
Interceptor.attach(accountReady, function () {
  if (drainingOutbound || !outboundQueue.length) return;
  let output: NativePointer;
  try {
    output = (this.context as X64CpuContext).rbx;
    const context = output.readPointer();
    if (context.isNull() || context.add(0x28).readPointer().isNull()) return;
  } catch (_) {
    return;
  }
  const job = outboundQueue.shift();
  drainingOutbound = true;
  try {
    job?.(output);
  } finally {
    drainingOutbound = false;
  }
});
function stdString(s: string): StdString {
  const n = unescape(encodeURIComponent(s)).length,
    object = Memory.alloc(24),
    bytes = Memory.allocUtf8String(s);
  object.writeByteArray(new ArrayBuffer(24));
  if (n < 23) {
    object.writeU8(n * 2);
    object.add(1).writeUtf8String(s);
  } else {
    object.writeU64((Math.ceil((n + 1) / 16) * 16) | 1);
    object.add(8).writeU64(n);
    object.add(16).writePointer(bytes);
  }
  return { object, bytes };
}
function readStdString(p: NativePointer): string {
  if (p.isNull()) return "";
  const long = (p.readU8() & 1) !== 0,
    n = long ? p.add(8).readU64().toNumber() : p.readU8() >>> 1;
  if (n > 2097152) throw Error("Native result exceeds limit");
  return (long ? p.add(16).readPointer() : p.add(1)).readUtf8String(n) || "";
}
let traceSends = false;
const sendTraces: SendTrace[] = [];
for (const [address, argument] of [
  [0x64ccca0, 2],
  [0x82e61c0, 1],
])
  Interceptor.attach(base.add(address), {
    onEnter(args) {
      if (!traceSends || sendTraces.length >= 16) return;
      try {
        const message = args[argument].readPointer();
        const strings = [];
        for (let offset = 0; offset < 512; offset += 8) {
          try {
            const field = message.add(offset),
              long = (field.readU8() & 1) !== 0;
            const length = long ? field.add(8).readU64().toNumber() : field.readU8() >>> 1;
            const capacity = long ? field.readU64().toNumber() - 1 : 23;
            if (length > 0 && length <= 8192 && length < capacity && capacity <= 262144)
              strings.push({ offset, value: readStdString(field) });
          } catch {}
        }
        sendTraces.push({
          entry: address.toString(16),
          vtable: message.readPointer().sub(base).toString(),
          bytes: Array.from(new Uint8Array(readBytes(message, 512)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
          strings,
          callers: Thread.backtrace(this.context, Backtracer.ACCURATE).map((p) =>
            p.sub(base).toString(),
          ),
        });
      } catch (error) {
        sendTraces.push({ error: String(error) });
      }
    },
  });
const assignString = new NativeFunction(base.add(0x450fdb0), "pointer", ["pointer", "pointer"]);
const uploads = createUploadHooks(base, OUTBOUND, readStdString, stdString);
function exactJSON(s: string): NativeSendResult {
  return JSON.parse(
    s.replace(/("(?:message_id|server_id|create_time)"\s*:\s*)(-?\d+)/g, '$1"$2"'),
  ) as NativeSendResult;
}
const invokeResult = new NativeCallback(
  (object, success, error) => {
    const job = outboundPending.get(object.toString());
    if (!job) return;
    try {
      const ok = readStdString(success),
        failure = readStdString(error);
      const result = ok
        ? exactJSON(ok)
        : {
            success: false,
            error_message: failure || "Native handler returned no result",
          };
      if (failure && !result.error_message) result.error_message = failure;
      job.resolve(result);
    } catch (e) {
      job.reject(e);
    }
  },
  "void",
  ["pointer", "pointer", "pointer"],
);
const destroyResult = new NativeCallback(
  (object) => {
    const key = object.toString();
    setImmediate(() => outboundPending.delete(key));
  },
  "void",
  ["pointer"],
);
function outboundCall(payload: string, queued = false): Promise<NativeSendResult> {
  return new Promise<NativeSendResult>((resolve, reject) => {
    const f = OUTBOUND.functions.generic_json_wrapper,
      address = base.add(f.rva);
    const actual = Array.from(new Uint8Array(readBytes(address, f.validation_bytes.length / 2)))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    if (actual !== f.validation_bytes) {
      reject(Error("Unsupported send function"));
      return;
    }
    const args = stdString(payload),
      context = stdString("wechat-api-" + ++outboundSequence);
    const callback = Memory.alloc(32),
      owner = Memory.alloc(Process.pointerSize);
    callback.writeByteArray(new ArrayBuffer(32));
    new NativeFunction(base.add(OUTBOUND.functions.callback_constructor.rva), "void", [
      "pointer",
      "pointer",
      "pointer",
    ])(callback, invokeResult, destroyResult);
    owner.writePointer(callback);
    let invoked = false,
      cancelled = false;
    const timer = setTimeout(() => {
      cancelled = true;
      if (!invoked) outboundPending.delete(callback.toString());
      reject(
        Error(
          invoked
            ? "Send acknowledgement timed out; delivery is uncertain; do not automatically retry"
            : "Timed out waiting for the native account thread; message was not sent",
        ),
      );
    }, 30000);
    outboundPending.set(callback.toString(), {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
      args,
      context,
      callback,
      owner,
    });
    const invoke = () => {
      if (cancelled) return;
      invoked = true;
      try {
        new NativeFunction(address, "void", ["pointer", "pointer", "pointer", "pointer"], {
          exceptions: "steal",
        })(nullPtr, args.object, context.object, owner);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    };
    if (queued) {
      try {
        if (outboundQueue.length >= 16) throw Error("Send queue full");
        outboundQueue.push(invoke);
      } catch (error) {
        clearTimeout(timer);
        outboundPending.delete(callback.toString());
        reject(error);
      }
    } else invoke();
  });
}

// Reproduce the captured desktop Quote workflow, on the account thread.
// The quote factory copies a native message record and its display information.
function nativeQuote(
  chat: string,
  content: string,
  reference: QuoteReference,
): Promise<NativeSendResult> {
  return new Promise<NativeSendResult>((resolve, reject) => {
    if (outboundQueue.length >= 16) return reject(Error("Send queue full"));
    let cancelled = false;
    const timer = setTimeout(() => {
      cancelled = true;
      reject(Error("Native account thread did not accept the quote"));
    }, 30000);
    outboundQueue.push(() => {
      if (cancelled) return;
      clearTimeout(timer);
      const holders: NativePointer[] = [],
        inputs: StdString[] = [],
        result = Memory.alloc(64);
      const record = Memory.alloc(0x350),
        extra = Memory.alloc(0x50),
        original = Memory.alloc(0x278);
      let initializedRecord = false,
        initializedExtra = false,
        initializedOriginal = false;
      let stage = "context";
      result.writeByteArray(new ArrayBuffer(64));
      const shared = (rva: number, parent?: NativePointer) => {
        const holder = Memory.alloc(16);
        holder.writeByteArray(new ArrayBuffer(16));
        holders.push(holder);
        if (parent)
          new NativeFunction(base.add(rva), "pointer", ["pointer", "pointer"])(holder, parent);
        else new NativeFunction(base.add(rva), "pointer", ["pointer"])(holder);
        return holder;
      };
      try {
        const context = shared(0x60421e0),
          root = shared(0x619ce90, context.readPointer());
        const manager = shared(0x61ad930, root.readPointer());
        stage = "record";
        const setString = (target: NativePointer, value: string) => {
          const input = stdString(value);
          inputs.push(input);
          assignString(target, input.object);
        };
        original.writeByteArray(new ArrayBuffer(0x278));
        new NativeFunction(base.add(0x5cdbc20), "void", ["pointer"])(original);
        initializedOriginal = true;
        setString(original.add(0x18), reference.sender);
        setString(original.add(0x30), chat);
        setString(original.add(0x48), reference.sender);
        setString(original.add(0x130), reference.content);
        setString(original.add(0x260), reference.name);
        original.add(0xf4).writeU32(reference.local_id);
        original.add(0xf8).writeU64(new UInt64(reference.id));
        original.add(0x100).writeU64(new UInt64(String(reference.timestamp)));
        original.add(0x114).writeU32(Math.floor(reference.timestamp / 1000));
        original.add(0x118).writeU32(2);
        new NativeFunction(base.add(0x605ab40), "void", ["pointer", "uint"])(
          original,
          reference.type % 0x100000000,
        );
        new NativeFunction(base.add(0x605b5a0), "void", ["pointer", "uint"])(
          original,
          Math.floor(reference.type / 0x100000000),
        );
        // Clone the native payload into the original record's owned shared pointer.
        new NativeFunction(base.add(0x605e8a0), "pointer", ["pointer", "pointer"])(
          record,
          original,
        );
        initializedRecord = true;
        setString(record.add(0x58), chat);
        if (readStdString(record.add(0x238).readPointer().add(0x130)) !== reference.content)
          throw Error("Native quote payload did not preserve the reference content");
        extra.writeByteArray(new ArrayBuffer(0x50));
        new NativeFunction(base.add(0x61124e0), "void", ["pointer"])(extra);
        initializedExtra = true;
        stage = "quote factory";
        const source = Memory.alloc(16);
        source.writeByteArray(new ArrayBuffer(16));
        holders.push(source);
        const text = stdString(content);
        new NativeFunction(base.add(0x738fec0), "pointer", [
          "pointer",
          "pointer",
          "pointer",
          "pointer",
        ])(source, record, text.object, extra);
        const message = source.readPointer();
        if (!message.readPointer().equals(base.add(0xa8a10c8)))
          throw Error("Unsupported quote source");
        const recipient = stdString(chat);
        assignString(message.add(0x90), recipient.object);
        assignString(message.add(0x190), recipient.object);
        message.add(0x1a8).writeU32(Math.floor(reference.timestamp / 1000));
        message.add(0x1ac).writeU32(reference.local_id);
        message.add(0x1b0).writeU64(new UInt64(String(reference.timestamp)));
        const vector = Memory.alloc(24);
        vector.writePointer(source);
        vector.add(8).writePointer(source.add(16));
        vector.add(16).writePointer(source.add(16));
        stage = "send handler";
        new NativeFunction(
          base.add(0x64da920),
          "pointer",
          ["pointer", "pointer", "pointer", "int"],
          { exceptions: "steal" },
        )(result, manager.readPointer(), vector, 1);
        resolve({ success: result.readU8() !== 0, error_message: readStdString(result.add(8)) });
      } catch (error) {
        const nativeDetails: Record<string, string> = {};
        const fault = error as { [name: string]: unknown; context?: CpuContext };
        for (const name of Object.getOwnPropertyNames(error))
          if (!["stack", "message"].includes(name)) nativeDetails[name] = String(fault[name]);
        if (fault.context) {
          nativeDetails.pc = fault.context.pc.sub(base).toString();
          nativeDetails.frames = Thread.backtrace(fault.context, Backtracer.ACCURATE)
            .map((address) => address.sub(base).toString())
            .join(",");
          nativeDetails.stackCandidates = Thread.backtrace(fault.context, Backtracer.FUZZY)
            .filter(
              (address) => address.compare(base) >= 0 && address.compare(base.add(0xa674ee0)) < 0,
            )
            .map((address) => address.sub(base).toString())
            .join(",");
        }
        reject(
          Error("Quote " + stage + ": " + String(error) + " " + JSON.stringify(nativeDetails)),
        );
      } finally {
        new NativeFunction(base.add(0x64d6d30), "void", ["pointer"])(result);
        const release = new NativeFunction(base.add(0x470a2e0), "void", ["pointer"]);
        for (const holder of holders.reverse()) release(holder);
        if (initializedExtra) new NativeFunction(base.add(0x6112500), "void", ["pointer"])(extra);
        if (initializedRecord) new NativeFunction(base.add(0x472f190), "void", ["pointer"])(record);
        if (initializedOriginal)
          new NativeFunction(base.add(0x5cdc000), "void", ["pointer"])(original);
      }
    });
  });
}

rpc.exports = {
  downloadinit: imageDownloads.initialize,
  downloadimage(account: unknown, chat: unknown, id: unknown, smoke: unknown, generation: unknown) {
    if (
      typeof chat !== "string" ||
      !chat ||
      unescape(encodeURIComponent(chat)).length > 256 ||
      /[\x00-\x1f\x7f]/.test(chat) ||
      typeof id !== "string" ||
      !/^[1-9]\d{0,19}$/.test(id) ||
      new UInt64(id).toString() !== id ||
      typeof smoke !== "boolean"
    )
      throw Error("Invalid image download request");
    if (
      typeof account !== "string" ||
      !account ||
      typeof generation !== "number" ||
      !Number.isInteger(generation) ||
      generation <= 0 ||
      generation >= 0xffffffff ||
      !sessionState().logged_in ||
      !accountMatches(account) ||
      generation !== imageDownloads.generation()
    )
      throw Error("WeChat account changed before download");
    return new Promise((resolve, reject) => {
      if (outboundQueue.length >= 16) return reject(Error("Native account queue full"));
      let cancelled = false;
      const timer = setTimeout(() => {
        cancelled = true;
        reject(Error("Native account thread did not accept the download"));
      }, 30000);
      outboundQueue.push((context) => {
        if (cancelled) return;
        clearTimeout(timer);
        if (
          !sessionState().logged_in ||
          !accountMatches(account) ||
          generation !== imageDownloads.generation()
        )
          return reject(Error("WeChat account changed before download"));
        void imageDownloads.request(context, chat, id, smoke, generation).then(resolve, reject);
      });
    });
  },
  traces(enabled: unknown, clear: unknown) {
    traceSends = enabled === true;
    if (clear) sendTraces.length = 0;
    return { enabled: traceSends, traces: sendTraces.slice() };
  },
  sendreply(chat: unknown, content: unknown, reference: QuoteReference | null) {
    if (
      typeof chat !== "string" ||
      !chat ||
      typeof content !== "string" ||
      !content ||
      content.length > 65536 ||
      !reference ||
      typeof reference !== "object" ||
      typeof reference.id !== "string" ||
      !/^\d{1,20}$/.test(reference.id) ||
      reference.id === "0" ||
      !Number.isSafeInteger(reference.local_id) ||
      reference.local_id < 1 ||
      reference.local_id > 0xffffffff ||
      typeof reference.content !== "string" ||
      reference.content.length > 262144 ||
      typeof reference.sender !== "string" ||
      !reference.sender ||
      typeof reference.name !== "string" ||
      !Number.isSafeInteger(reference.type) ||
      reference.type < 1 ||
      !Number.isSafeInteger(reference.timestamp) ||
      reference.timestamp < 0
    )
      throw Error("Invalid quoted reply");
    return nativeQuote(chat, content, reference);
  },
  sendfile(chat: unknown, path: unknown, name: unknown) {
    if (
      typeof chat !== "string" ||
      !chat ||
      typeof path !== "string" ||
      !/^\/home\/wechat\/\.cache\/wechatlinux\/uploads\/[a-f0-9-]{36}\/[^/\\\x00-\x1f]{1,200}$/.test(
        path,
      ) ||
      typeof name !== "string" ||
      path.split("/").pop() !== name
    )
      throw Error("Invalid file upload");
    const marker = "http://127.0.0.1:18742/native-file/" + path.split("/").at(-2);
    const escape = (value: string) =>
      value.replace(
        /[&<>"']/g,
        (c: string) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[
            c as "&" | "<" | ">" | '"' | "'"
          ],
      );
    uploads.register("file", marker, path);
    const xml = `<msg><appmsg><title>${escape(name)}</title><type>6</type><appattach><cdnattachurl>${marker}</cdnattachurl><aeskey>${"0".repeat(32)}</aeskey></appattach></appmsg></msg>`;
    return outboundCall(
      JSON.stringify({ chat_id: chat, message_type: 49, content_xml: xml }),
      true,
    );
  },
  sendimage(chat: unknown, path: unknown) {
    if (
      typeof chat !== "string" ||
      !chat ||
      typeof path !== "string" ||
      !/^\/home\/wechat\/\.cache\/wechatlinux\/uploads\/[a-f0-9-]{36}\.(png|jpg|gif)$/.test(path)
    )
      throw Error("Invalid image upload");
    const marker = "http://127.0.0.1:18742/native-upload/" + path.split("/").pop();
    uploads.register("image", marker, path);
    return outboundCall(
      JSON.stringify({ chat_id: chat, message_type: 3, content_xml: marker }),
      true,
    );
  },
  sendprobe() {
    return outboundCall("{}");
  },
  sendtext(chat: unknown, content: unknown) {
    if (typeof chat !== "string" || !chat || typeof content !== "string" || !content)
      throw Error("Invalid message");
    return outboundCall(
      JSON.stringify({ chat_id: chat, message_type: 1, content_xml: content }),
      true,
    );
  },
  login: session.login,
  loginqr: session.qr,
  logout: session.logout,
  status() {
    return {
      sqlite_version: text(native.libversion()),
      ...sessionState(),
      download_generation: imageDownloads.generation(),
      revision,
      databases: connections.size,
      query_batch: queryBatch.stats(),
    };
  },
  scanqr: scanQR,
  databases() {
    enterInternal();
    try {
      const unique = new Map<string, DatabaseConnection>();
      const activePaths = new Set(
        Array.from(connections.values(), (connection) => connection.path),
      );
      for (const c of [...retained.values(), ...connections.values()]) {
        const old = unique.get(c.path);
        if (!old || c.key) unique.set(c.path, c);
      }
      return Array.from(unique.values()).map((c) => {
        try {
          reader(c);
        } catch (_) {}
        return {
          id: c.id,
          path: c.path,
          encrypted: !!c.key,
          readable: c.readable,
          active: activePaths.has(c.path),
          error: c.error,
          key_captured: !!c.key,
          cipher_settings: c.cipher,
        };
      });
    } finally {
      leaveInternal();
    }
  },
  query(id: unknown, sql: unknown, maxRows: number) {
    if (typeof sql !== "string" || sql.length > 65536) throw Error("Invalid SQL");
    const c = [...connections.values(), ...retained.values()].find((c) => c.id === id);
    if (!c) throw Error("Unknown or closed database handle");
    enterInternal();
    try {
      return sqlQuery(reader(c), sql, Math.max(1, Math.min(maxRows || 1000, 50001)));
    } finally {
      leaveInternal();
    }
  },
};
send({ type: "ready", sqlite_version: text(native.libversion()) });
