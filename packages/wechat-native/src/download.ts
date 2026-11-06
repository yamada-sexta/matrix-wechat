// Only the non-yielding producer/polling ABI crosses Frida. Native lookup and
// download execute inside the separately stacked C++ callback in download.cc.
export function createDownloader() {
  let binding: ReturnType<typeof load> | undefined;
  let failed = false;
  let generation = 0;
  function load() {
    const open = new NativeFunction(Module.getGlobalExportByName("dlopen"), "pointer", [
      "pointer",
      "int",
    ]);
    // RTLD_NOW | RTLD_NODELETE. Native callbacks may outlive this Frida script.
    const handle = open(Memory.allocUtf8String(DOWNLOAD_ADAPTER), 0x1002);
    if (handle.isNull()) throw Error("Native download adapter could not be loaded");
    const symbol = new NativeFunction(Module.getGlobalExportByName("dlsym"), "pointer", [
      "pointer",
      "pointer",
    ]);
    const address = (name: string) => {
      const p = symbol(handle, Memory.allocUtf8String(name));
      if (p.isNull()) throw Error("Missing native download adapter entry");
      return p;
    };
    const init = new NativeFunction(address("wechat_download_init"), "int", ["pointer"]);
    if (init(Process.mainModule.base) !== 0) throw Error("Unsupported native download ABI");
    const api = {
      submit: new NativeFunction(address("wechat_download_submit"), "pointer", [
        "pointer",
        "pointer",
        "ulong",
        "uint64",
        "int",
        "uint",
      ]),
      status: new NativeFunction(address("wechat_download_status"), "int", ["pointer"]),
      release: new NativeFunction(address("wechat_download_release"), "void", ["pointer"]),
      invalidate: new NativeFunction(address("wechat_download_invalidate"), "uint", []),
    };
    generation = api.invalidate();
    if (!generation) throw Error("Native download session generation exhausted");
    return api;
  }
  function initialize() {
    if (failed) throw Error("Native image downloads disabled after an adapter failure");
    try {
      binding ??= load();
    } catch (error) {
      failed = true;
      throw error;
    }
    return { generation };
  }
  async function request(
    context: NativePointer,
    chat: string,
    id: string,
    smoke: boolean,
    expectedGeneration: number,
  ) {
    initialize();
    if (expectedGeneration !== generation)
      throw Error("WeChat session changed before native download");
    const api = binding!;
    let handle: NativePointer;
    try {
      handle = api.submit(
        context,
        Memory.allocUtf8String(chat),
        unescape(encodeURIComponent(chat)).length,
        new UInt64(id),
        Number(smoke),
        expectedGeneration,
      );
    } catch (error) {
      failed = true;
      throw error;
    }
    if (handle.isNull()) throw Error("Native download queue is full or not ready");
    try {
      const deadline = Date.now() + 30000;
      while (true) {
        let state: number;
        try {
          state = api.status(handle);
        } catch (error) {
          failed = true;
          throw error;
        }
        if (state === 2 || state === 3) return { requested: state === 2, smoke: state === 3 };
        if (state < 0) {
          if (state === -2) failed = true;
          throw Error(`Native download rejected (${state})`);
        }
        if (Date.now() >= deadline) throw Error("Native download callback is still pending");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      // This releases the polling handle, never memory still owned by a callback.
      try {
        api.release(handle);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  return {
    request,
    initialize,
    generation: () => generation,
    invalidate() {
      if (binding) generation = binding.invalidate();
    },
  };
}
