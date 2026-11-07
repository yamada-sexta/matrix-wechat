import { randomUUID } from "node:crypto";
import { APIError, type ChangeBatch, type ChangeCursor, type Event, publicFields } from "./types";

// A bounded replay buffer. Overflow/restart explicitly requests historical recovery.
export class ChangeJournal {
  readonly epoch = randomUUID();
  private cursor = 0;
  private floor = 0;
  private bytes = 0;
  private entries: { cursor: number; event: Event; bytes: number }[] = [];
  private waiters = new Set<() => void>();
  constructor(
    private readonly maxEntries = 512,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}
  append(value: Event) {
    const event = publicFields(value),
      bytes = Buffer.byteLength(JSON.stringify(event));
    const cursor = ++this.cursor;
    if (bytes > this.maxBytes) {
      this.entries = [];
      this.bytes = 0;
      this.floor = cursor;
    } else {
      this.entries.push({ cursor, event, bytes });
      this.bytes += bytes;
      while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes) {
        const old = this.entries.shift()!;
        this.floor = old.cursor;
        this.bytes -= old.bytes;
      }
    }
    for (const wake of [...this.waiters]) wake();
  }
  read(input: ChangeCursor): ChangeBatch {
    const reset =
      input.epoch !== this.epoch ||
      input.cursor === undefined ||
      input.cursor < this.floor ||
      input.cursor > this.cursor;
    return {
      epoch: this.epoch,
      cursor: this.cursor,
      reset,
      events: reset
        ? []
        : this.entries.filter((entry) => entry.cursor > input.cursor!).map((entry) => entry.event),
    };
  }
  async poll(input: ChangeCursor, signal?: AbortSignal): Promise<ChangeBatch> {
    const current = this.read(input);
    if (current.reset || current.events.length || !input.wait_ms) return current;
    if (signal?.aborted) throw new APIError("cancelled", "Change request cancelled");
    if (this.waiters.size >= 64) throw new APIError("not_ready", "Too many change subscribers");
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(new APIError("cancelled", "Change request cancelled"));
      };
      timer = setTimeout(wake, Math.min(input.wait_ms!, 25000));
      this.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      // Check again after subscribing so an append between read and subscribe is retained.
      if (signal?.aborted) abort();
      else if (this.cursor !== current.cursor) wake();
    });
    return this.read(input);
  }
}
