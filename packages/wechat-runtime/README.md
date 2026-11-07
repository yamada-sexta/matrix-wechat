# WeChat runtime

[English](README.md) | [简体中文](README.zh-CN.md)

Container-only WeChat Linux 4.1.13 instrumentation, Bun + TypeScript API, and React chat UI. The native executable is pinned by SHA-256.

```sh
packages/wechat-runtime/scripts/container.sh build
packages/wechat-runtime/scripts/container.sh start
```

Open http://127.0.0.1:18742/. Login is initiated explicitly through the UI or bridge commands. Set `WECHAT_AUTO_LOGIN=true` to opt into automatic phone-confirmation requests. WeChat may require phone confirmation. Without a remembered account, the page displays the client's QR code.

The Dockerfile downloads the original vendor AppImage from the repository's [pinned client release](https://github.com/yamada-sexta/matrix-wechat/releases/tag/wechat-client-4.1.13-4526180b), retries transient failures up to three times, checks the SHA-256 from the native ABI profile, and extracts and verifies the executable during build. `WECHAT_APPIMAGE_URL` can override the download mirror while retaining the same hash pin. The expected AppImage hash is `4526180bca980128791599af122ff4795002a5715a510f6a65480e2be6874244`. A changed download fails the build. Both hashes are checked again before startup. The client installation is read-only to the runtime user; the image contains no account data.

The Dockerfile lives in this package, but its build context is the repository root so it can include `packages/wechat-rpc`. The build runs lint, type checking and tests, then builds the native hook and React UI with the root workspace lockfile. CI builds the same amd64 Dockerfile and checks the bundled client without launching WeChat. Writable account state is mounted from repository `data/wechat` to container `/home/wechat`. The launcher publishes only `127.0.0.1:18742`, uses private PID/display namespaces, and grants `SYS_PTRACE` for Frida plus `SYS_CHROOT` for the embedded browser sandbox. No host home, display, or IPC is mounted. Server startup rejects host execution.

```sh
packages/wechat-runtime/scripts/container.sh stop
packages/wechat-runtime/scripts/container.sh start
packages/wechat-runtime/scripts/container.sh logs --tail 30
```

Stop/start preserves state. Rebuild and stop/start after source changes; no manual copying into a running container is needed.

Development checks do not launch WeChat:

```sh
bun install --frozen-lockfile
bun run --cwd packages/wechat-runtime check
bun run --cwd packages/wechat-runtime lint
bun run --cwd packages/wechat-runtime test
bun run --cwd packages/wechat-runtime build
```

## Service API and optional web UI

The Matrix bridge runs in a separate container and connects through the shared `wechat-rpc` client. Set `WECHAT_API_TOKEN` to enable the authenticated API on port `18743`; every request requires `Authorization: Bearer <token>`. Without a token this listener is disabled. Compose supplies the same token to both services and keeps this port internal.

The typed tRPC API at `/trpc` exposes status, contacts, groups, conversations, resumable history, recent messages, a bounded long-poll change journal, revocations, login and logout, text sends, and multipart image/file uploads. Reads are scoped to the current account, including its retained database shards; databases from a previous account are excluded. Authenticated `/assets/avatar`, `/assets/media`, `/assets/thumbnail`, and `/assets/qr` return binary bytes without base64 encoding. History carries public media checksums for echo correlation; native raw records stay inside this service.

Group responses include `joined` when the cached native roster and account contact are available. System XML is normalized into readable message text and a `system.type` such as `payment_reminder`; native XML and payment action URLs are not part of the public response.

`WECHAT_WEB_UI` defaults to `true`. Set it to `false` to disable the separate web UI/HTTP listener on `18742`; the authenticated API remains available. The standalone launcher loads `WECHAT_*` and `TZ` settings from the repository `.env` if present and accepts exported `WECHAT_API_TOKEN` and `WECHAT_WEB_UI` overrides. Matrix credentials stay out of the runtime container. It publishes only the web UI port. Use the root [Compose configuration](../../compose.yaml) for a bridge/runtime deployment on a shared network.

The web UI also exposes a local HTTP API:

Use `rpc.login.mutate({ mode: "qr" })` or `{ mode: "prompt" }` to initiate login, and `rpc.logout.mutate()` to end the current native session. The local UI uses `POST /api/login` with the same login payload and `POST /api/logout` with `{}`. During logout, status is `logging_out`; success means native authentication has ended, rather than merely queuing an action. A failed logout returns an error and refreshes status from the native client. Logout follows the native client's chat-history setting; automatic login is suppressed until an explicit login request. WeChat may require a fresh camera QR scan afterward.

HTTP API: `GET /api/status`, `/api/contacts`, `/api/groups`, `/api/conversations`, `/api/history?chat_id=...&limit=50&cursor=...`, `/api/capabilities`; `GET /api/events` provides Server-Sent Events; `POST /api/send` accepts `{ "chat_id": "...", "kind": "text", "text": "..." }`. Native IDs remain decimal strings. Browser responses exclude native raw rows, key material, and paths. Errors use `{ "error": { "code": "...", "message": "..." } }`.

Text and quoted replies use native send handlers; image and file uploads use native upload handlers. A send acknowledgement reports the native handler result; delivery is verified from source history with a server ID. Receiving supports cached images, MP4 videos, files, profile pictures, stickers/GIFs, and decoded voice audio. Video reads verify message size and checksum, with a 64 MiB limit. Use the File button or `POST /api/send-file` for MP4 uploads: WeChat may classify them as native video messages, as verified with an H.264 sample. Uncached video downloading and other video formats remain unverified. Other send types remain unverified. Incoming updates use native database write hooks followed by committed-state reconciliation; a direct global message callback remains unverified. API/schema/investigation notes live in entirely ignored `wechat_api/`.

Native ABI metadata lives in the `wechat-native` workspace's `src/*_profile.toml`. Bun's TOML reader loads the runtime profiles, and Zod validates their hashes, addresses, and instruction bytes before injection. Zod also validates login and text-send parameters at the shared runtime boundary for HTTP and the private socket. Vendor payloads and the API wire protocol retain XML/JSON. Bun's SQLite connector runs the storage fixtures; encrypted account databases are read through the client's native WCDB connection.

Repository-root `bun run check` checks all workspaces. `wechat-runtime` checks the Bun/React app; `wechat-native` checks injected code with Frida types and no Bun/browser globals. The runtime TypeScript project has no native-file exclusions.

The C++ image adapter is built and tested in the runtime Dockerfile's build stages. Automatic original-image requests start disabled. The private socket's `download.validate` action takes `{chat_id,message_id}` for an image whose original is missing, runs a native coroutine smoke callback, requests original variant 3, and checks the resulting cached image against the message MD5. Only successful validation enables retries for that account and writes a private attestation bound to the adapter, client, and coroutine-library hashes. `download.status` reports activation without exposing account identifiers. The bridge continues to show the thumbnail and retains its retry flag until the verified original replaces the existing Matrix event.

Git ignores account data, local notes, dependencies, build output, QR images, logs, databases, and captures. No personal data belongs in source, fixtures, or the Docker build context.

To approve desktop login requests from an ADB-connected phone, run this on the host while the container runs with the web UI listener enabled:

```sh
bun packages/wechat-runtime/scripts/adb-login.ts --watch
```

The watcher checks the local API for a pending phone confirmation, matches WeChat's desktop login prompt through Android UI automation, and presses its login button. When WeChat hides accessibility controls, it checks the exact desktop-login activity and locates the large green button from an in-memory screenshot. It waits when the phone is locked. Use `ANDROID_SERIAL` when multiple ADB devices are connected. Omit `--watch` for one check; Ctrl+C stops the watcher. UI dumps are temporary files on the phone and are deleted after each check; account and conversation text are not logged.

Schema metadata is cached by database identity and SQLite schema version. Committed write hints coalesce affected tables; uncertain SQL or triggers widen the scan. Full snapshots run at least once a minute, and failed scans retain their previous snapshot. Pending media uses bounded filesystem watchers as hints; only message-bound checksum verification emits availability. The bridge and runtime must be deployed at matching versions.
