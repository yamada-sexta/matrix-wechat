import { type FSWatcher, watch } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

interface Pending {
  root: string;
  directories: string[];
  probe: () => Promise<boolean>;
  ready: () => void;
  touched: number;
  busy: boolean;
  again: boolean;
  bindings: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}
// Filesystem events are hints. A message-bound checksum probe decides availability.
export class MediaWatch {
  private entries = new Map<string, Pending>();
  private watchers = new Map<string, { watcher: FSWatcher; keys: Set<string> }>();
  private timer?: ReturnType<typeof setInterval>;
  watch(
    key: string,
    root: string,
    directories: string[],
    probe: Pending["probe"],
    ready: Pending["ready"],
  ) {
    const old = this.entries.get(key);
    if (old) {
      old.probe = probe;
      old.ready = ready;
      old.touched = Date.now();
      return;
    }
    if (this.entries.size >= 64) this.remove(this.entries.keys().next().value!);
    const entry: Pending = {
      root,
      directories,
      probe,
      ready,
      touched: Date.now(),
      busy: false,
      again: false,
      bindings: new Set(),
    };
    this.entries.set(key, entry);
    this.timer ??= setInterval(() => {
      for (const [key, entry] of this.entries) {
        if (Date.now() - entry.touched > 10 * 60000) this.remove(key);
        else this.schedule(key);
      }
    }, 15000);
    this.timer.unref();
    this.schedule(key);
  }
  private schedule(key: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.timer) return;
    if (entry.busy) {
      entry.again = true;
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.check(key, entry);
    }, 100);
    entry.timer.unref();
  }
  private async bind(key: string, entry: Pending) {
    const root = await realpath(entry.root),
      wanted = new Set<string>();
    for (let path of entry.directories) {
      while (path === entry.root || path.startsWith(entry.root + "/")) {
        try {
          const actual = await realpath(path);
          if (
            (actual === root || actual.startsWith(root + "/")) &&
            (await stat(actual)).isDirectory()
          )
            wanted.add(actual);
          break;
        } catch (error: any) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") break;
        }
        if (path === entry.root) break;
        path = dirname(path);
      }
    }
    if (this.entries.get(key) !== entry) return;
    for (const path of [...entry.bindings]) if (!wanted.has(path)) this.unbind(key, path, entry);
    for (const path of wanted) {
      let shared = this.watchers.get(path);
      if (!shared) {
        if (this.watchers.size >= 128) continue;
        try {
          const watcher = watch(path, { persistent: false }, () => {
            for (const key of this.watchers.get(path)?.keys || []) this.schedule(key);
          });
          shared = { watcher, keys: new Set() };
          this.watchers.set(path, shared);
          watcher.on("error", () => {
            watcher.close();
            this.watchers.delete(path);
          });
        } catch {
          continue;
        }
      }
      shared.keys.add(key);
      entry.bindings.add(path);
    }
  }
  private async check(key: string, entry: Pending) {
    if (entry.busy || this.entries.get(key) !== entry) return;
    entry.busy = true;
    try {
      await this.bind(key, entry);
      if (
        this.entries.get(key) === entry &&
        (await entry.probe()) &&
        this.entries.get(key) === entry
      ) {
        this.remove(key);
        entry.ready();
      }
    } catch {
    } finally {
      entry.busy = false;
      if (entry.again) {
        entry.again = false;
        this.schedule(key);
      }
    }
  }
  private unbind(key: string, path: string, entry: Pending) {
    entry.bindings.delete(path);
    const shared = this.watchers.get(path);
    shared?.keys.delete(key);
    if (shared && !shared.keys.size) {
      shared.watcher.close();
      this.watchers.delete(path);
    }
  }
  remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    for (const path of [...entry.bindings]) this.unbind(key, path, entry);
    if (!this.entries.size) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  clear() {
    for (const key of [...this.entries.keys()]) this.remove(key);
  }
}
