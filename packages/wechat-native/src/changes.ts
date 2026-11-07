export interface WriteScope {
  table?: string;
  schema?: boolean;
}
export interface DatabaseWrite {
  id: string;
  path: string;
  tables?: string[];
  schema: boolean;
}
const uncomment = (sql: string) => sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
export const transactionEnd = (sql: string) =>
  /^(COMMIT|END|ROLLBACK|RELEASE)\b/i.test(uncomment(sql));

// Unknown SQL always widens the scan. Values/bindings never leave the process.
export function writeScope(sql: string): WriteScope {
  sql = uncomment(sql);
  if (/^\s*(CREATE|DROP|ALTER|REINDEX|VACUUM|ATTACH|DETACH)\b/i.test(sql)) return { schema: true };
  const token = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z_0-9]*)';
  const match = sql.match(
    new RegExp(
      "^\\s*(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+(" +
        token +
        ")(?:\\s*\\.\\s*(" +
        token +
        "))?",
      "i",
    ),
  );
  if (!match) return {};
  const quoted = match[2] || match[1];
  const table =
    quoted[0] === '"'
      ? quoted.slice(1, -1).replaceAll('""', '"')
      : quoted[0] === "`"
        ? quoted.slice(1, -1).replaceAll("``", "`")
        : quoted[0] === "["
          ? quoted.slice(1, -1)
          : quoted;
  return table.length <= 256 ? { table: table.toLowerCase() } : {};
}

export class CommittedWrites {
  private transactions = new Map<
    string,
    { path: string; tables: Set<string> | null; schema: boolean }
  >();
  private ready = new Map<string, DatabaseWrite>();
  private scheduled = false;
  constructor(
    private readonly publish: (change: DatabaseWrite) => void,
    private readonly schedule: (callback: () => void) => void = (callback) => {
      setTimeout(callback, 25);
    },
  ) {}
  record(id: string, path: string, scope: WriteScope) {
    const current = this.transactions.get(id) || { path, tables: new Set<string>(), schema: false };
    current.schema ||= scope.schema === true;
    if (!scope.table || (current.tables?.size || 0) >= 32) current.tables = null;
    else current.tables?.add(scope.table);
    this.transactions.set(id, current);
  }
  commit(id: string) {
    const change = this.transactions.get(id);
    if (!change) return;
    this.transactions.delete(id);
    const previous = this.ready.get(id);
    const tables =
      previous && (!previous.tables || !change.tables)
        ? undefined
        : [...new Set([...(previous?.tables || []), ...(change.tables || [])])];
    this.ready.set(id, {
      id,
      path: change.path,
      schema: change.schema || previous?.schema === true,
      tables: change.tables && tables && tables.length <= 32 ? tables : undefined,
    });
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => {
        this.scheduled = false;
        const ready = [...this.ready.values()];
        this.ready.clear();
        for (const write of ready) this.publish(write);
      });
    }
  }
  forget(id: string) {
    this.transactions.delete(id);
    this.ready.delete(id);
  }
}
