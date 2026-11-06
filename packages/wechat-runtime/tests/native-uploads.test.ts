import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { outboundProfileSchema } from "wechat-native/profiles";

const profile = outboundProfileSchema.parse(
  Bun.TOML.parse(
    await readFile(new URL(import.meta.resolve("wechat-native/outbound_profile.toml")), "utf8"),
  ),
);
const bundle = await Bun.build({
  entrypoints: [new URL(import.meta.resolve("wechat-native/uploads")).pathname],
  target: "browser",
  format: "cjs",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Upload hook test build failed");
const source = await bundle.outputs[0].text();

function fixture(corrupt?: string) {
  const code = new Map<number, Uint8Array>(),
    strings = new Map<number, string>(),
    timers = new Map<number, () => void>(),
    probes = new Map<number, (this: { context: unknown }) => void>(),
    writes: number[] = [];
  let sequence = 1;
  class Pointer {
    constructor(readonly address: number) {}
    add(offset: number | string) {
      return new Pointer(this.address + Number(offset));
    }
    readByteArray(length: number) {
      return code.get(this.address)?.slice(0, length).buffer ?? null;
    }
  }
  for (const [name, fn] of Object.entries(profile.uploads)) {
    const bytes = Uint8Array.from(Buffer.from(fn.validation_bytes, "hex"));
    if (name === corrupt) bytes[0] ^= 1;
    code.set(Number(fn.rva), bytes);
  }
  const readString = (object: Pointer) => {
    const value = strings.get(object.address);
    if (value === undefined) throw Error("Invalid string pointer");
    return value;
  };
  const string = (value: string) => {
    const object = new Pointer(sequence++);
    strings.set(object.address, value);
    return object;
  };
  const sandbox = {
    NativeFunction: function () {
      return (target: Pointer, input: Pointer) => {
        strings.set(target.address, readString(input));
        writes.push(target.address);
      };
    },
    Interceptor: {
      attach(address: Pointer, callback: unknown) {
        // Model the supported coroutine-safe API: no native return callbacks.
        if (typeof callback !== "function") throw Error("A true instruction probe is required");
        probes.set(address.address, callback as (this: { context: unknown }) => void);
      },
    },
    setTimeout(callback: () => void) {
      const id = sequence++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    Uint8Array,
  };
  const module = { exports: {} as { createUploadHooks: (...args: unknown[]) => any } };
  runInNewContext(source, { ...sandbox, module, exports: module.exports });
  const install = () =>
    module.exports.createUploadHooks(new Pointer(0), profile, readString, (value: string) => ({
      object: string(value),
      bytes: new Pointer(0),
    }));
  const file = (marker: Pointer, stack: number) => {
    const output = new Pointer(stack + 0x1b0);
    strings.set(output.address, "original native path");
    probes.get(Number(profile.uploads.file_path_ready.rva))!.call({
      context: { rbp: marker, rsp: new Pointer(stack) },
    });
    return output;
  };
  const image = (marker: Pointer) => {
    probes.get(Number(profile.uploads.image_entry.rva))!.call({ context: { rcx: marker } });
  };
  return { install, string, file, image, strings, readString, timers, probes, writes };
}

test("uploads follow their coroutine stack and marker, independent of thread reuse and ordering", () => {
  const f = fixture(),
    hooks = f.install(),
    first = f.string("http://127.0.0.1:18742/native-file/first"),
    second = f.string("http://127.0.0.1:18742/native-file/second");
  hooks.register("file", f.readString(first), "/uploads/first/文档.txt");
  hooks.register("file", f.readString(second), "/uploads/second/other.txt");
  expect(f.probes.size).toBe(2);
  // Two suspended jobs resume in reverse order on the same native worker.
  const secondOutput = f.file(second, 0x20000),
    unrelated = f.file(f.string("unrelated desktop upload"), 0x30000),
    firstOutput = f.file(first, 0x10000);
  expect(f.readString(firstOutput)).toBe("/uploads/first/文档.txt");
  expect(f.readString(secondOutput)).toBe("/uploads/second/other.txt");
  expect(f.readString(unrelated)).toBe("original native path");
  expect(f.writes).toEqual([secondOutput.address, firstOutput.address]);
  expect(f.timers.size).toBe(0);
});

test("image paths are copied into native ownership and survive temporary input collection", () => {
  const f = fixture(),
    hooks = f.install(),
    marker = f.string("http://127.0.0.1:18742/native-upload/image.png"),
    desktop = f.string("/desktop/original.png");
  hooks.register("image", f.readString(marker), "/uploads/image.png");
  f.image(desktop);
  f.image(marker);
  for (const address of f.strings.keys())
    if (address !== marker.address && address !== desktop.address) f.strings.delete(address);
  expect(f.readString(marker)).toBe("/uploads/image.png");
  expect(f.readString(desktop)).toBe("/desktop/original.png");
  expect(f.writes).toEqual([marker.address]);
  expect(f.timers.size).toBe(0);
});

test("late native uploads retain markers until consumption, while expired markers do nothing", () => {
  const f = fixture(),
    hooks = f.install(),
    marker = f.string("http://127.0.0.1:18742/native-file/late");
  hooks.register("file", f.readString(marker), "/uploads/late.txt");
  expect(f.timers.size).toBe(1);
  const output = f.file(marker, 0x10000);
  expect(f.readString(output)).toBe("/uploads/late.txt");
  hooks.register("file", f.readString(marker), "/uploads/expired.txt");
  for (const expire of f.timers.values()) expire();
  expect(f.readString(f.file(marker, 0x20000))).toBe("original native path");
  expect(f.writes).toHaveLength(1);
});

test("any changed upload instruction window rejects startup before installing probes", () => {
  for (const name of Object.keys(profile.uploads)) {
    const f = fixture(name);
    expect(f.install).toThrow(`Unsupported upload instructions: ${name}`);
    expect(f.probes.size).toBe(0);
  }
});
