# Bridge setup

[English](setup.md) | [简体中文](setup.zh-CN.md)

This guide is for administrators who want to host the bridge with Docker Compose. For building from source and running checks, see [Development](development.md).

## Requirements

- An amd64 Linux host with Docker and the Docker Compose plugin. The runtime includes a pinned x86-64 WeChat Linux client.
- A Matrix homeserver with application-service support, and permission to register an appservice.
- An existing Matrix account to use as the bridge owner, and a WeChat account on your phone to approve desktop login.
- Git and OpenSSL for the commands below.

One bridge instance serves one Matrix owner and follows whichever WeChat account is logged into its runtime. SQLite is included; no separate database server is needed.

## 1. Prepare the configuration

```sh
git clone https://github.com/yamada-sexta/matrix-wechat.git
cd matrix-wechat
mkdir -p data/bridge data/wechat
cp example-config.yaml data/bridge/config.yaml
```

Run subsequent commands from this repository directory. If you already have a configuration, edit it instead of copying over it.

Generate a shared API secret:

```sh
openssl rand -hex 32
```

Create a `.env` file in the repository root with the generated value:

```dotenv
WECHAT_API_TOKEN=replace_with_the_generated_secret
```

If `.env` already exists, add the setting there. Both containers use this secret for bridge-to-runtime requests. It is separate from the Matrix registration tokens generated later.

```sh
chmod 600 .env
```

Edit `data/bridge/config.yaml`:

| Setting | Value |
| --- | --- |
| `homeserver.address` | The homeserver URL **as reached from the bridge container**, such as `http://synapse:8008` on a shared Docker network or `https://matrix.example.com`. |
| `homeserver.domain` | Your Matrix server name: `example.com` for `@you:example.com`. This may differ from the hostname in the URL above. |
| `appservice.address` | The bridge URL **as reached from the homeserver**, such as `http://bridge:17778` on a shared Docker network. |
| `bridge.owner` | Your full Matrix user ID, such as `'@you:example.com'`. Only this user can control the bridge. |

Keep `wechat.address: http://wechat-runtime:18743`, `appservice.hostname: 0.0.0.0`, and the `/data/...` paths from the example when using the supplied Compose file. `/data` inside the bridge container is `data/bridge` on the host.

### Homeserver networking

The homeserver must reach the bridge, and the bridge must reach the homeserver. Inside a container, `localhost` refers to that container.

If your homeserver runs in another Compose project, connect the bridge to its existing Docker network. Create `compose.override.yaml` alongside `compose.yaml`:

```yaml
services:
  bridge:
    networks:
      - default
      - homeserver

networks:
  homeserver:
    external: true
    name: synapse_default
```

Replace `synapse_default` with the homeserver's network name (`docker network ls` lists networks). The bridge stays on its default network to reach the runtime. Compose loads the override automatically.

If the homeserver has the network alias `synapse`, use `homeserver.address: http://synapse:8008` and `appservice.address: http://bridge:17778`.

If the homeserver runs directly on the same host, it can reach the bridge at `http://127.0.0.1:17778`, which Compose publishes on the host. Set `homeserver.address` to a URL reachable from inside Docker. A homeserver on another machine needs a reachable bridge endpoint; the default localhost-only port binding will not provide one.

### Data permissions

Both images run as UID/GID `1000:1000`. The bridge must read its configuration and write `data/bridge`; the runtime must write `data/wechat`. If your host user has a different UID, give these directories to the container user before continuing:

```sh
sudo chown -R 1000:1000 data/bridge data/wechat
```

## 2. Get the images and generate registration

The Compose file uses the published `:master` images:

```sh
docker compose pull
docker compose run --rm --no-deps bridge --check-config
docker compose run --rm --no-deps bridge -g
```

To build locally instead, replace `docker compose pull` with `docker compose build`.

The last command creates `data/bridge/registration.yaml`. Generation refuses to overwrite an existing registration; keep that file when restarting or updating. The configuration check validates settings without testing network connectivity.

## 3. Register the appservice

The bridge and homeserver must use the same generated registration. Keep the bridge's copy at `data/bridge/registration.yaml`.

For Synapse, copy or mount that file somewhere Synapse can read, then add its path to `homeserver.yaml`:

```yaml
app_service_config_files:
  - /data/wechat-registration.yaml
```

Append to any existing list. For containerized Synapse, the path is **inside its container**. For example, add this read-only bind mount to the Synapse service, replacing the host path:

```yaml
volumes:
  - /absolute/path/to/matrix-wechat/data/bridge/registration.yaml:/data/wechat-registration.yaml:ro
```

Ensure Synapse can read the file, then restart it (or recreate its container if you added a mount). Other homeservers have their own procedure; see the [appservice registration guide](https://docs.mau.fi/bridges/general/registering-appservices.html).

## 4. Start and log in

```sh
docker compose up -d
docker compose logs --tail=100 bridge wechat-runtime
```

Accept the invitation to the bridge's management room in Matrix and send `login qr`. Scan the image with WeChat on your phone and complete any confirmation. For a remembered account, `login prompt` requests phone approval instead.

You can also initiate login from the runtime web UI at <http://127.0.0.1:18742/>. On a remote host, forward the port to your computer:

```sh
ssh -L 18742:127.0.0.1:18742 user@bridge-host
```

After login, the bridge creates private rooms for visible WeChat conversations and imports locally cached history. Accept the room invitations and send `status` in the management room to check the connection. See [Usage](usage.md) for commands.

Compose publishes the web UI (`18742`) and Matrix appservice (`17778`) only on localhost. The authenticated runtime API (`18743`) stays on the container network.

## Optional settings

### Disable the web UI

Add `WECHAT_WEB_UI=false` to `.env`, then recreate the runtime:

```sh
docker compose up -d --force-recreate wechat-runtime
```

The authenticated API and Matrix login commands remain available. The host-side ADB watcher requires the web UI listener.

### Double puppeting

Double puppeting makes new messages sent from your WeChat account appear as your real Matrix user and lets the bridge accept invitations to its own rooms for you. Without it, messages use ghost accounts and you accept invitations manually.

1. Install a separate double-puppeting appservice registration on your homeserver using the [registration instructions](https://docs.mau.fi/bridges/general/double-puppeting.html#automatically). Its non-exclusive user namespace must include `bridge.owner`. A suitable existing registration can be reused; keep the bridge's ghost registration unchanged.
2. Add that registration's **bare `as_token` value** to `.env`:

   ```dotenv
   MATRIX_OWNER_AS_TOKEN=replace_with_the_double_puppeting_as_token
   ```

3. Recreate the bridge:

   ```sh
   docker compose up -d --force-recreate bridge
   ```

`MATRIX_OWNER_AS_TOKEN` is specific to this bridge. Do not include the `as_token:` prefix used in mautrix examples. Compose passes it only to the bridge. The bridge verifies the owner identity at startup; previously imported authors and voluntary room departures are preserved.

## Updates and backups

Preserve `.env`, `data/bridge`, and `data/wechat`. They contain credentials, room mappings and history cursors, and WeChat account/session files. Stop the services before backing them up. Do not run two runtimes against the same account directory.

To update published images:

```sh
docker compose pull
docker compose up -d
```

Use `docker compose stop` to stop both services while preserving data, or `docker compose restart bridge` to restart only the Matrix bridge. Image updates require `up -d` to recreate containers. The former Go configuration and database are not migrated.

## Troubleshooting

- **Missing `WECHAT_API_TOKEN`:** check that `.env` is in the repository root with a non-empty value.
- **Permission denied:** check data directory ownership and whether the homeserver can read its registration copy.
- **No management invitation or Matrix messages do not reach WeChat:** check both directions of network access, the registration URL, and that the homeserver loaded the registration. Check bridge and homeserver logs.
- **WeChat is logged out or disconnected:** send `status`, then `login prompt` or `login qr`. Check runtime logs if the client does not start.
- **Registration already exists:** reuse it. If registration-related settings change, update both copies consistently and restart the homeserver and bridge. Do not delete it just to restart services.
