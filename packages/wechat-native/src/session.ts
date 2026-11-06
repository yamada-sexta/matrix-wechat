// Native session operations run on Qt's owning thread; this module owns their ABI and lifetimes.
export function createSession(onChange: (kind: string) => void) {
  const base = Process.mainModule.base,
    nil = ptr(0);
  const addresses = Object.fromEntries(
    Object.entries(SESSION.functions).map(([name, fn]) => {
      const address = base.add(fn.rva),
        bytes = address.readByteArray(fn.validation_bytes.length / 2);
      if (
        !bytes ||
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("") !==
          fn.validation_bytes
      )
        throw Error(`Unsupported session function: ${name}`);
      return [name, address];
    }),
  );
  const allocate = new NativeFunction(addresses.allocate, "pointer", ["ulong"]);
  const free = new NativeFunction(addresses.free, "void", ["pointer"]);
  const queue = new NativeFunction(addresses.queue, "void", ["int", "int", "pointer", "pointer"], {
    exceptions: "steal",
  });
  const nativeLogout = new NativeFunction(addresses.logout, "void", ["pointer"]);
  let model = nil;
  function controller() {
    const object = base.add(SESSION.controller.rva).readPointer();
    if (!object.isNull() && !object.readPointer().equals(base.add(SESSION.controller.vtable)))
      throw Error("Unsupported session controller");
    return object;
  }
  function loggedIn() {
    const object = controller();
    return !object.isNull() && object.add(0x10).readPointer().add(0x18).readU32() === 2;
  }
  function loginState() {
    if (model.isNull() || !model.readPointer().equals(base.add(SESSION.login.vtable)))
      return { active: false };
    return {
      active: true,
      phase: model.add(0x44).readU32(),
      request: model.add(0x4c).readU32(),
      can_resume: model.add(0x338).readU8() !== 0,
    };
  }
  function qr() {
    if (loggedIn() || loginState().phase !== 0) return { bytes: [] };
    const current = model,
      field = current.add(SESSION.login.qr_data_offset),
      long = (field.readU8() & 1) !== 0,
      length = long ? field.add(8).readU64().toNumber() : field.readU8() >>> 1;
    if (!length || length > 256000) return { bytes: [] };
    const data = long ? field.add(16).readPointer() : field.add(1),
      bytes = data.readByteArray(length);
    if (!bytes || !current.equals(model) || loginState().phase !== 0) return { bytes: [] };
    return { bytes: Array.from(new Uint8Array(bytes)) };
  }
  function slot(context: NativePointer, callback: NativePointer) {
    const object = allocate(24);
    object.writeU32(1);
    object.add(4).writeU32(0);
    object.add(8).writePointer(callback);
    object.add(16).writePointer(context);
    return object;
  }
  function login(mode: unknown) {
    if (mode !== "qr" && mode !== "prompt") throw Error("Invalid login action");
    const state = loginState();
    if (!state.active) return { queued: false };
    if (mode === "prompt" && !state.can_resume) return { queued: false, reason: "qr_required" };
    const window = model.sub(SESSION.login.model_offset);
    if (!window.readPointer().equals(base.add(SESSION.login.window_vtable)))
      throw Error("Invalid login window");
    const object = slot(window, mode === "qr" ? addresses.qr_slot : addresses.prompt_slot);
    try {
      queue(0, 0, window, object);
    } catch (error) {
      free(object);
      throw error;
    }
    return { queued: true };
  }
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  // QSlotObjectBase: operation 1 invokes; operation 0 destroys using the matching native delete.
  const logoutSlot = new NativeCallback(
    (operation, object) => {
      const key = object.toString(),
        job = pending.get(key);
      if (operation === 0 || operation === 1) pending.delete(key);
      if (operation === 0) {
        job?.reject(Error("Logout context was destroyed before invocation"));
        free(object);
      } else if (operation === 1 && job) {
        try {
          if (loggedIn()) {
            const current = controller();
            if (!current.equals(object.add(16).readPointer()))
              throw Error("Session changed before logout");
            nativeLogout(current);
          }
          job.resolve();
        } catch (error) {
          job.reject(Error(String(error)));
        }
      }
    },
    "void",
    ["int", "pointer", "pointer", "pointer", "pointer"],
  );
  async function logout() {
    const context = controller();
    if (context.isNull()) throw Error("Session controller is not ready");
    if (!loggedIn()) {
      if ([3, 4].includes(loginState().phase ?? -1))
        throw Error("Login is in progress; wait before logging out");
      return { success: true };
    }
    const deadline = Date.now() + 30000;
    await new Promise<void>((resolve, reject) => {
      const object = slot(context, logoutSlot),
        key = object.toString();
      // Cancellation removes the job so a delayed Qt callback cannot perform a timed-out action.
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(Error("Timed out waiting for the Qt logout action"));
      }, deadline - Date.now());
      pending.set(key, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        queue(0, 0, context, object);
      } catch (error) {
        pending.get(key)?.reject(Error(String(error)));
        pending.delete(key);
        free(object);
      }
    });
    // Native logout is asynchronous. A queued action alone is not a completed logout.
    while (loggedIn()) {
      if (Date.now() >= deadline)
        throw Error("Logout was requested but the native session is still active");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return { success: true };
  }
  type ModelInvocation = InvocationContext & { model?: NativePointer };
  Interceptor.attach(addresses.model_constructor, {
    onEnter(this: ModelInvocation, args) {
      this.model = args[0];
    },
    onLeave(this: ModelInvocation) {
      if (!this.model) return;
      model = this.model;
      onChange("login_view_open");
    },
  });
  Interceptor.attach(addresses.model_destructor, {
    onEnter(args) {
      if (model.equals(args[0])) {
        model = nil;
        onChange("login_view_closed");
      }
    },
  });
  Interceptor.attach(addresses.model_state_changed, {
    onEnter(args) {
      if (args[0].equals(model)) onChange("login_state_changed");
    },
  });
  return {
    login,
    logout,
    qr,
    status: () => ({
      logged_in: loggedIn(),
      login: loginState(),
    }),
  };
}
