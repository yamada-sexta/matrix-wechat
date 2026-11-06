# Matrix–WeChat

A Bun/TypeScript Matrix bridge using `matrix-appservice-bridge` and the existing pinned WeChat Linux runtime. The bridge follows whichever WeChat account is currently logged into the runtime, for one configured Matrix owner.

The services run in **two separate containers**:

| Package | Responsibility | Dockerfile | Ports |
| --- | --- | --- | --- |
| `packages/wechat-runtime` | Runs WeChat, owns account files, exposes its authenticated API and optional React web UI | `packages/wechat-runtime/Dockerfile` | `18742` web UI, `18743` internal API |
| `packages/matrix-bridge` | Matrix appservice, room mappings, history cursors, and send tracking | `packages/matrix-bridge/Dockerfile` | `17778` appservice |
| `packages/wechat-rpc` | Shared tRPC contract, types, and client; no container | — | — |

The bridge calls the runtime over HTTP. It does not launch WeChat, access account files, or import native runtime code. Bridge state is stored with `bun:sqlite` under `data/bridge`; WeChat account state stays under `data/wechat`. The web UI belongs to the runtime container.

## Configure and start

```sh
mkdir -p data/bridge
cp example-config.yaml data/bridge/config.yaml
# Create a shared API secret once. This refuses to overwrite an existing .env.
bun -e 'import {writeFileSync} from "node:fs"; writeFileSync(".env", "WECHAT_API_TOKEN=" + crypto.randomUUID() + "\n", {flag:"wx", mode:0o600})'
```

Edit `data/bridge/config.yaml`: set `homeserver.address`, `homeserver.domain`, `appservice.address`, and `bridge.owner`. `wechat.address` defaults to `http://wechat-runtime:18743` on the Compose network. Both services receive the same `WECHAT_API_TOKEN` from `.env`; the token is separate from Matrix registration tokens.

```sh
docker compose build
docker compose run --rm --no-deps bridge -g
```

Register `data/bridge/registration.yaml` with your homeserver and restart it. `appservice.address` must be reachable from the homeserver; `homeserver.address` must be reachable from the bridge. Join the homeserver to the Compose network when these URLs use container names.

```sh
docker compose up -d
```

Open http://127.0.0.1:18742/ for WeChat login and chat inspection. Compose publishes the web UI and appservice on localhost; API port `18743` stays on the container network. To disable the web UI, put `WECHAT_WEB_UI=false` in `.env` and recreate the runtime container. The default is enabled. Disabling the UI does not disable the authenticated API or Matrix login commands.

To enable double puppeting, put `MATRIX_OWNER_AS_TOKEN=<bare appservice token>` in `.env`; Compose passes it only to the bridge container. This variable is bridge configuration, not an SDK-defined setting. The bridge uses the SDK's `MatrixClient.impersonateUserId()` for the owner identity. Use an existing double-puppeting appservice registration with a non-exclusive user namespace including `bridge.owner`, installed on the homeserver. This is separate from the bridge's ghost registration, and the value has no `as_token:` prefix. See the [double-puppeting setup guide](https://docs.mau.fi/bridges/general/double-puppeting.html) for homeserver registration. The bridge verifies the owner identity, accepts pending invitations to its own rooms, and mirrors new messages sent from your WeChat account as your real Matrix account. Mirrored events carry an echo marker so they are not sent back to WeChat. Voluntary departures and previously imported event authors are preserved. Without this token, the owner accepts invitations manually and WeChat messages use ghost accounts. Keep this credential out of source control and out of the runtime container.

The bridge invites its configured owner to a management room. Login is command based: send `login qr` for one QR image, or `login prompt` to request phone approval for the account remembered by WeChat. The web UI has a Log out button, and the management room accepts `logout`. Logout uses the native Qt session action and returns success only after WeChat confirms that authentication has ended. It follows the client's chat-history setting and disables automatic login until you explicitly request login. The runtime reports `logging_out` while waiting; the bridge sends the owner one notice after completion. A session drop also produces one logout notice, followed by one recovery notice when login returns. QR refreshes and intermediate login states stay silent. Outgoing messages queued during an outage receive one waiting notice. Use `status` to check progress. The optional host-side ADB watcher can approve the desktop-login prompt:

```sh
bun packages/wechat-runtime/scripts/adb-login.ts --watch
```

Portal history remains readable while WeChat is unavailable, logged out, or using another account, but the owner cannot send new Matrix messages into those portals. Sending is also disabled when the native group roster confirms that the current account is no longer a member. The bridge restores the owner's previous power level when access returns; the management room stays writable for login/logout commands. Missing or incomplete roster data does not establish that a user was removed.

The watcher uses the local web API and requires the web UI listener to be enabled. See [runtime documentation](packages/wechat-runtime/README.md) for standalone use and the pinned client build.

## Bridged behavior

After login, the bridge creates private Matrix rooms for visible WeChat conversations and imports the full locally cached history oldest first, in resumable pages. It polls normalized history through tRPC and reconciles recent updates and revocations. Persistent cursors and mappings survive either service restarting. Restarting the bridge leaves the WeChat client and web UI running.

Incoming messages include text, replies, mentions, images, stickers/GIFs, cached MP4 video, voice decoded to WAV, files, locations, system notices, shared links, and WeChat Channels cards. Article cards include a compact thumbnail beside their title and description; Channels retain a video cover and show video only when the existing runtime can provide playable bytes. Cached names, avatars, group announcements, and rosters are mirrored.

Transfers and red packets are **read only**: Matrix receives a formatted card with the available amount, memo or greeting, and a read-only label. The bridge cannot collect a transfer or open a red packet. They can be quoted like other normal messages; system messages cannot be quoted. Card layouts use [Matrix-supported HTML](https://spec.matrix.org/v1.19/client-server-api/#mroommessage-msgtypes), with plain-text fallbacks and link-preview metadata for clients that support it; appearance varies by Matrix client.

Missing cached media produces a readable placeholder and is retried in rotating batches. When an image has only a cached thumbnail, the bridge shows a labeled preview. Once WeChat caches the verified original, the bridge edits the existing Matrix message to include it, including after a bridge restart. Explicit revocations redact the corresponding Matrix event; disappearance from storage does not imply revocation.

Outgoing support covers text, text replies, JPEG/PNG/GIF images, files, and MP4 through the existing file-upload route. Native acknowledgement is not delivery confirmation: the bridge waits for a matching source record with a server ID and suppresses its echo. Ambiguous or interrupted sends are reported as uncertain and are never automatically resubmitted, including when an API connection fails during a send.

Matrix emoji reactions are sent as quoted text replies containing the reaction emoji. The reacted-to message must have a confirmed WeChat message ID in that conversation.

Sticker/voice/location sending, native mention construction, native revocation, group/profile mutations, presence, encrypted Matrix rooms, and uncached-media download initiation are unsupported. Unplayable Channels video remains a cover card. Leaving a Matrix room does not leave its WeChat group. No additional native capabilities are implemented here.

## Commands

Only `bridge.owner` can issue commands. Send them in the management room, or prefix them with `!wechat` in a portal:

- `help`, `status`, `capabilities`
- `login qr`, `login prompt` (bare `login` requests phone approval)
- `logout` (ends the current native session)
- `list contacts`, `list groups`
- `start-chat <cached contact or conversation ID>`
- `sync`

CLI options: `-c <config>`, `-r <registration>`, `-g` (generate registration), `-e` (write example configuration), `--check-config`, and `--version`. Generation refuses to overwrite existing files. The former Go configuration/database is not migrated.

## Development and images

Run dependency installation from the repository root; all three packages share its Bun lockfile.

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run test
bun run build
podman build -f packages/matrix-bridge/Dockerfile -t localhost/matrix-wechat:dev .
podman build -f packages/wechat-runtime/Dockerfile -t localhost/wechatlinux-demo:dev .
```

Both Dockerfiles use the repository root as their build context. CI builds and publishes separate `ghcr.io/yamada-sexta/matrix-wechat` and `ghcr.io/yamada-sexta/matrix-wechat-runtime` images. Only the runtime image contains the pinned amd64 WeChat client, Frida, and GUI dependencies; the bridge needs no native-client capabilities or WeChat data volume.

CI caches Docker layers separately for each amd64 image using the GitHub Actions cache. The runtime prepares and verifies its read-only client before copying application code, so source changes reuse the large client layer. Dependency layers depend on the workspace manifests and lockfile. Cache export has a five-minute timeout and is best-effort; build and verification failures still fail CI. The first build after a client or cache change may be slower while it populates the cache.

CI builds only images affected by a push or pull request. Bridge and runtime changes select their own image; shared RPC code, workspace manifests, the lockfile, Docker context exclusions, and CI changes select both. Documentation and deployment-only changes skip image builds. Release tags and manual runs build both images.

To view CI logs, open Actions, select a run, and select its `matrix-bridge` or `wechat-runtime` job. If GitHub's job viewer shows no steps, raw logs may still be available through `gh run view RUN_ID --log` (for example, `gh run view 38475530231 --log`). Use `--log-failed` to filter failed steps when GitHub's step metadata is available. Lint, type checks, tests, and bundling output appear inside **Build and cache verification image**; reused Docker layers appear as `CACHED` and do not repeat their previous output.

The [E2E runner](packages/matrix-bridge/scripts/e2e.ts) has focused cases:

```sh
bun run test:matrix all --build   # Rebuild both images and run every case
bun run test:matrix quote        # Only text reference + quoted reply
bun run test:matrix image file video
bun run test:matrix history      # History, rich cards, and exact received media
bun run test:matrix restart outage
bun run test:matrix permissions encryption
```

Without `--build`, existing local images are reused; missing images are built automatically. Each run starts separate runtime, Synapse, and bridge containers, registers a test Matrix owner and appservice, and starts the ADB login watcher. Scan the QR manually if WeChat cannot request phone confirmation. All outgoing tests target **File Transfer only**. Transfers and red packets are never sent or collected; incoming payment cards are checked in the history case. Images, files, and MP4 tests reuse actual cached account bytes, so those examples must be available in the account.

If running, the standalone `wechatlinux-demo` container is temporarily stopped to prevent concurrent account access, then restored. Override images with `BRIDGE_IMAGE` and `WECHAT_RUNTIME_IMAGE`; override the existing container with `WECHATLINUX_CONTAINER`. Private logs and proof summaries stay under ignored `data/matrix-acceptance/`.
