# Using the bridge

[English](usage.md) | [简体中文](usage.zh-CN.md)

First complete [Bridge setup](setup.md). The bridge serves `bridge.owner` and follows the account currently logged into WeChat.

## Logging in

Accept the invitation to the management room. Send `login qr`, scan the image with WeChat on your phone, and approve desktop login. The command sends one QR image; request another if needed.

If the desktop client remembers your account, send `login prompt` to request phone approval. Bare `login` does the same thing. You can also log in through the runtime web UI at <http://127.0.0.1:18742/> when enabled. Compose disables automatic login requests, so initiate login explicitly.

After login, private Matrix rooms are created for visible WeChat conversations. These rooms are called portals. The bridge invites you and imports the full locally cached history, oldest first. This can take time; progress survives restarts. With [double puppeting](setup.md#double-puppeting), pending invitations to the bridge's rooms are accepted automatically.

## Commands

Only `bridge.owner` can issue commands. Send them directly in the management room. In a portal, prefix them with `!wechat` (or your configured `bridge.command_prefix`), for example `!wechat status`.

| Command | Purpose |
| --- | --- |
| `help` | List available commands. |
| `status` | Show current runtime status. |
| `capabilities` | Show supported and unsupported operations. |
| `login qr` | Request a QR image. |
| `login prompt` | Request phone approval for the remembered account. |
| `logout` | End the native WeChat session. |
| `list contacts` | List cached contacts and their IDs. |
| `list groups` | List cached groups and their IDs. |
| `start-chat <ID>` | Create or open a portal using a cached contact or conversation ID. |
| `sync` | Request a synchronization pass. |

Use `list contacts` or `list groups` to find an ID for `start-chat`. Leaving a Matrix portal does not leave the WeChat group.

## Sending messages

Send messages in a portal to send them to the corresponding WeChat conversation. Text, text replies, JPEG/PNG/GIF images, files, and MP4 uploads are supported. Emoji reactions become quoted text replies containing the emoji; the target must have a confirmed WeChat message ID.

The bridge waits for a matching WeChat source record with a server ID before treating a send as confirmed. Ambiguous or interrupted sends are reported as uncertain and are never automatically resubmitted. Check WeChat before retrying an uncertain send.

See [Features and limitations](features.md) for incoming messages and media handling.

## Logout and connection loss

Send `logout` or use the web UI's Log out button. Logout follows the native client's chat-history setting. Success is reported only after WeChat confirms authentication has ended; `status` shows `logging_out` while waiting. Automatic login stays disabled until you explicitly request login again.

The bridge sends one logout or connection-loss notice, then one recovery notice when login returns. QR refreshes and intermediate login states stay silent. Messages already queued during an outage receive one waiting notice.

Existing portals remain readable while the runtime is unavailable, logged out, or using another account, but new Matrix sends into those portals are disabled. Sending is also disabled when the native group roster confirms that the account is no longer a member. Incomplete roster data alone does not establish removal. Your previous power level is restored when access returns; the management room stays writable for login commands.

## Optional Android login watcher

With Bun and an ADB-connected Android phone, run this from the repository root to approve pending desktop-login prompts:

```sh
bun packages/wechat-runtime/scripts/adb-login.ts --watch
```

The runtime web UI listener must be enabled. The watcher waits when the phone is locked. Set `ANDROID_SERIAL` for multiple devices. Omit `--watch` for one check; Ctrl+C stops the watcher. See the [runtime documentation](../packages/wechat-runtime/README.md) for details.
