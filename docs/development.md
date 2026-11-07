# Development

[English](development.md) | [简体中文](development.zh-CN.md)

For deployment configuration, homeserver registration, and first login, see [Bridge setup](setup.md).

## Repository layout

| Package | Responsibility |
| --- | --- |
| `packages/matrix-bridge` | Matrix appservice, room mappings, history cursors, and send tracking. |
| `packages/wechat-runtime` | WeChat client, account files, authenticated API, and optional React web UI. |
| `packages/wechat-rpc` | Shared tRPC contract, types, and client. |
| `packages/wechat-native` | Frida instrumentation, pinned native profiles, and C++ download adapter bundled into the runtime. |

The bridge and runtime run in separate containers, communicating over HTTP through `wechat-rpc`. The bridge does not launch WeChat, access its account files, or import native runtime code. Bridge state uses `bun:sqlite` under `data/bridge`; WeChat state stays under `data/wechat`. Restarting the bridge leaves the client and web UI running.

See the [runtime](../packages/wechat-runtime/README.md) and [native](../packages/wechat-native/README.md) documentation for client pinning, instrumentation, and standalone runtime operation.

## Local checks and images

Use Bun 1.3.14, as pinned in `package.json` and the Dockerfiles. Run dependency installation from the repository root; all four packages share its Bun lockfile.

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run test
bun run build
podman build -f packages/matrix-bridge/Dockerfile -t localhost/matrix-wechat:dev .
podman build -f packages/wechat-runtime/Dockerfile -t localhost/wechatlinux-demo:dev .
```

The checks do not launch WeChat. `bun run build` builds the runtime application and React UI; the bridge runs its TypeScript entry point directly. Both Dockerfiles use the repository root as their build context. Substitute Docker for Podman if preferred, or use `docker compose build` for deployment images.

Only the runtime image contains the pinned amd64 WeChat client, Frida, and GUI dependencies; the bridge needs no native-client capabilities or WeChat data volume.

## Bridge CLI

The entry point is `packages/matrix-bridge/src/main.ts` (`bun run start` from the repository root).

| Option | Purpose |
| --- | --- |
| `-c <config>` | Select the configuration file; default `config.yaml`. |
| `-r <registration>` | Override the registration path from the configuration. |
| `-g` | Generate the appservice registration. |
| `-e` | Write an example configuration. |
| `--check-config` | Validate configuration without starting the bridge. |
| `--version` | Print the bridge and Bun versions. |

Generation refuses to overwrite existing files. The container entry point already supplies `-c /data/config.yaml`.

## CI

CI builds and publishes separate `ghcr.io/yamada-sexta/matrix-wechat` and `ghcr.io/yamada-sexta/matrix-wechat-runtime` images for amd64.

CI caches Docker layers separately for each amd64 image using the GitHub Actions cache. The runtime prepares and verifies its read-only client before copying application code, so source changes reuse the large client layer. Dependency layers depend on the workspace manifests and lockfile. Cache export has a five-minute timeout and is best-effort; build and verification failures still fail CI. The first build after a client or cache change may be slower while it populates the cache.

CI builds only images affected by a push or pull request. Bridge and runtime changes select their own image; shared RPC code, workspace manifests, the lockfile, Docker context exclusions, and CI changes select both. Documentation and deployment-only changes skip image builds. Release tags and manual runs build both images.

To view CI logs, open Actions, select a run, and select its `matrix-bridge` or `wechat-runtime` job. If GitHub's job viewer shows no steps, raw logs may still be available through `gh run view RUN_ID --log`. Use `--log-failed` to filter failed steps when GitHub's step metadata is available. Lint, type checks, tests, and bundling output appear inside **Build and cache verification image**; reused Docker layers appear as `CACHED` and do not repeat their previous output.

## Live end-to-end tests

The [E2E runner](../packages/matrix-bridge/scripts/e2e.ts) requires Podman, Bun, an ADB-connected phone for its login watcher, and real WeChat account data under `data/wechat`. It has focused cases:

```sh
bun run test:matrix all --build   # Rebuild both images and run every case
bun run test:matrix quote        # Only text reference + quoted reply
bun run test:matrix image file video
bun run test:matrix history      # History, rich cards, and exact received media
bun run test:matrix restart outage
bun run test:matrix permissions encryption
```

Without `--build`, existing local images are reused; missing images are built automatically. Each run starts separate runtime, Synapse, and bridge containers, registers a test Matrix owner and appservice, and starts the ADB login watcher. Scan the QR manually if WeChat cannot request phone confirmation. All outgoing tests target **File Transfer only**. Transfers and red packets are never sent or collected; incoming payment cards are checked in the history case. Images, files, and MP4 tests reuse actual cached account bytes, so those examples must be available in the account.

If running, the standalone `wechatlinux-demo` container is temporarily stopped to prevent concurrent account access, then restored. Stop any other runtime using `data/wechat`, including the Compose runtime, before running the tests. Override images with `BRIDGE_IMAGE` and `WECHAT_RUNTIME_IMAGE`; override the existing container with `WECHATLINUX_CONTAINER`. Private logs and proof summaries stay under ignored `data/matrix-acceptance/`.
