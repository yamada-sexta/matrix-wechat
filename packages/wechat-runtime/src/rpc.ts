import { timingSafeEqual } from "node:crypto";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type Backend, router } from "wechat-rpc/router";
import { APIError, publicFields } from "wechat-rpc/types";
import type { Runtime } from "./runtime";

export function createRPCHandler(runtime: Runtime, token: string) {
  if (!token) throw new Error("WECHAT_API_TOKEN is required to expose the runtime API");
  const ready = <T>(fn: () => Promise<T>) =>
    runtime.operation(() => {
      if (runtime.status.state !== "logged_in")
        throw new APIError("not_ready", "WeChat is still signing in");
      return fn().then(publicFields);
    });
  const backend: Backend = {
    changes: (input) => runtime.changes.poll(input),
    status: () => ({
      status: runtime.status,
      qrAt: runtime.qrAt,
      qrAvailable: !!runtime.qr && Date.now() - runtime.qrAt <= 8000,
    }),
    contacts: async () => publicFields((await runtime.dispatch("contacts")).contacts),
    groups: async () => publicFields((await runtime.dispatch("groups")).groups),
    conversations: async () => (await runtime.dispatch("conversations")).conversations,
    history: ({ chat, cursor }) => ready(() => runtime.store.bridgeHistory(chat, cursor)),
    recent: (chat) => ready(() => runtime.store.bridgeRecent(chat, 500)),
    revocations: () => ready(() => runtime.store.bridgeRevocations()),
    login: (input) => runtime.login(input),
    logout: () => runtime.logout(),
    send: (input) => runtime.dispatch("send", input),
    upload: async (chat, file, kind) =>
      kind === "image"
        ? runtime.sendImage(chat, Buffer.from(await file.arrayBuffer()))
        : runtime.sendFile(chat, Buffer.from(await file.arrayBuffer()), file.name),
  };
  return async (request: Request): Promise<Response> => {
    const supplied = Buffer.from(request.headers.get("Authorization") || ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return Response.json(
        { error: { code: "unauthorized", message: "Runtime API token is required" } },
        { status: 401 },
      );
    const url = new URL(request.url);
    if (url.pathname.startsWith("/trpc/"))
      return fetchRequestHandler({
        endpoint: "/trpc",
        req: request,
        router,
        createContext: () => ({
          ...backend,
          changes: (input) => runtime.changes.poll(input, request.signal),
        }),
      });
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    try {
      const chat = url.searchParams.get("chat") || "",
        id = url.searchParams.get("id") || "";
      let asset: { bytes: Buffer; type: string; name?: string };
      switch (url.pathname) {
        case "/assets/avatar":
          asset = await runtime.avatar(id);
          break;
        case "/assets/media":
          asset = await runtime.media(chat, id);
          break;
        case "/assets/thumbnail":
          asset = await runtime.thumbnail(chat, id);
          break;
        case "/assets/qr":
          if (!backend.status().qrAvailable)
            throw new APIError("qr_unavailable", "QR is not available");
          asset = { bytes: runtime.qr!, type: "image/png" };
          break;
        default:
          return new Response(null, { status: 404 });
      }
      return new Response(new Uint8Array(asset.bytes), {
        headers: {
          ...headers,
          "Content-Type": asset.type,
          ...(asset.name ? { "X-Filename": encodeURIComponent(asset.name) } : {}),
        },
      });
    } catch (error) {
      const known = error instanceof APIError;
      return Response.json(
        {
          error: {
            code: known ? error.code : "internal_error",
            message: known ? error.message : "Runtime operation failed",
          },
        },
        { status: known && error.code === "invalid_params" ? 400 : 503, headers },
      );
    }
  };
}
