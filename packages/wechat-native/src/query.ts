export type DatabaseValue = string | number | null | { bytes: number[] };
export interface QueryResult {
  columns: string[];
  rows: DatabaseValue[][];
  truncated: boolean;
}

export function createQueryBatch() {
  let binding: ReturnType<typeof load> | undefined;
  const counters = { batched: 0 };
  function load() {
    const open = new NativeFunction(Module.getGlobalExportByName("dlopen"), "pointer", [
      "pointer",
      "int",
    ]);
    const handle = open(Memory.allocUtf8String(QUERY_ADAPTER), 0x1002);
    if (handle.isNull()) throw Error("Native query adapter unavailable");
    const symbol = new NativeFunction(Module.getGlobalExportByName("dlsym"), "pointer", [
      "pointer",
      "pointer",
    ]);
    const address = (name: string) => {
      const p = symbol(handle, Memory.allocUtf8String(name));
      if (p.isNull()) throw Error("Missing native query entry");
      return p;
    };
    const functions = [
      "prepare_v2",
      "step",
      "finalize",
      "stmt_readonly",
      "column_count",
      "column_name",
      "column_type",
      "column_int64",
      "column_double",
      "column_text",
      "column_blob",
      "column_bytes",
      "errmsg",
    ];
    const table = Memory.alloc(Process.pointerSize * functions.length);
    for (const [index, name] of functions.entries())
      table
        .add(index * Process.pointerSize)
        .writePointer(Process.mainModule.base.add(PROFILE.functions[name]));
    // The executable and libowl have different exception TLS. Bind only the
    // previously verified main-executable entry points, never global exports.
    const eh = [
      [0x44f3ce0, "415653504889fb4c8b37e87116000049"],
      [0x44f3ea0, "53e84a150000488b384885ff7425488b"],
      [0x44f4690, "55415741564154534883ec30b8030000"],
      [0x44eee20, "4156534881ecb80100004889fbe81e07"],
    ] as const;
    const exceptionTable = Memory.alloc(Process.pointerSize * eh.length);
    for (const [index, [offset, expected]] of eh.entries()) {
      const p = Process.mainModule.base.add(offset);
      const bytes = p.readByteArray(16);
      if (
        !bytes ||
        Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("") !==
          expected
      )
        throw Error("Unsupported native exception ABI");
      exceptionTable.add(index * Process.pointerSize).writePointer(p);
    }
    const init = new NativeFunction(address("wechat_query_init"), "int", ["pointer", "pointer"]);
    if (init(table, exceptionTable) !== 0) throw Error("Native query initialization failed");
    return {
      run: new NativeFunction(address("wechat_query_run"), "int", [
        "pointer",
        "pointer",
        "uint",
        "int",
        "pointer",
        "pointer",
      ]),
      free: new NativeFunction(address("wechat_query_free"), "void", ["pointer"]),
    };
  }
  function query(db: NativePointer, sql: string, limit: number, allowWrite = false): QueryResult {
    binding ??= load();
    const out = Memory.alloc(Process.pointerSize),
      size = Memory.alloc(8);
    out.writePointer(ptr(0));
    size.writeU64(0);
    const rc = binding.run(db, Memory.allocUtf8String(sql), limit, allowWrite ? 1 : 0, out, size);
    const buffer = out.readPointer();
    try {
      const n = Number(size.readU64());
      if (buffer.isNull() || !Number.isSafeInteger(n))
        throw Error("Native query allocation failed");
      const value = n ? buffer.readUtf8String(n) : "";
      if (rc !== 0) throw Error(value || "Native SQLite query failed");
      counters.batched++;
      return JSON.parse(value || "") as QueryResult;
    } finally {
      if (!buffer.isNull()) binding.free(buffer);
    }
  }
  return { query, stats: () => ({ ...counters }) };
}
