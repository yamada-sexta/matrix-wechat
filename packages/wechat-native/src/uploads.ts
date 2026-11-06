import type { OutboundProfile } from "./profiles";

// No invocation or thread-local state may span WeChat's coroutine switches.
// Each probe completes at one instruction; only native-owned string copies escape it.
export function createUploadHooks(
  base: NativePointer,
  profile: OutboundProfile,
  readString: (object: NativePointer) => string,
  makeString: (value: string) => { object: NativePointer; bytes: NativePointer },
) {
  const addresses = Object.fromEntries(
    Object.entries(profile.uploads).map(([name, fn]) => {
      const address = base.add(fn.rva),
        bytes = address.readByteArray(fn.validation_bytes.length / 2);
      if (
        !bytes ||
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("") !==
          fn.validation_bytes
      )
        throw Error(`Unsupported upload instructions: ${name}`);
      return [name, address];
    }),
  );
  const assign = new NativeFunction(addresses.assign_string, "pointer", ["pointer", "pointer"]);
  const files = new Map<string, { path: string; timer: ReturnType<typeof setTimeout> }>(),
    images = new Map<string, { path: string; timer: ReturnType<typeof setTimeout> }>();
  function register(kind: "file" | "image", marker: string, path: string) {
    const sources = kind === "file" ? files : images;
    if (sources.has(marker)) throw Error("Upload marker already registered");
    const source = {
      path,
      // An acknowledgement can precede the scheduled native sender. Retain the
      // marker until consumption, or expire it with the runtime's source file.
      timer: setTimeout(() => sources.delete(marker), 120000),
    };
    sources.set(marker, source);
  }
  function consume(sources: typeof files, markerObject: NativePointer, target: NativePointer) {
    if (!sources.size) return;
    const marker = readString(markerObject),
      source = sources.get(marker);
    if (!source) return;
    const input = makeString(source.path);
    // libc++ assignment allocates/copies with WeChat's allocator. Never hand
    // asynchronous native code a pointer owned by Frida's garbage collector.
    assign(target, input.object);
    clearTimeout(source.timer);
    sources.delete(marker);
  }
  // 0x82e8c10 preserves its marker argument in RBP. The validated call window
  // constructs the path at RSP+0x1b0; this probe runs immediately after it.
  // Do not use onLeave, even on the nested path builder: it can suspend.
  Interceptor.attach(addresses.file_path_ready, function () {
    const context = this.context as X64CpuContext;
    consume(files, context.rbp, context.rsp.add(0x1b0));
  });
  Interceptor.attach(addresses.image_entry, function () {
    const context = this.context as X64CpuContext;
    // Mutate the caller's native string rather than replacing RCX with a
    // temporary allocation. The caller retains/destroys that string normally.
    consume(images, context.rcx, context.rcx);
  });
  return { register };
}
