# Features and limitations

[English](features.md) | [简体中文](features.zh-CN.md)

## History and synchronization

After login, the bridge creates private Matrix rooms for visible WeChat conversations and imports the full locally cached history oldest first, in resumable pages. An authenticated change journal wakes only affected conversations; a full recovery pass runs every minute. Journal gaps or a runtime restart replay cached history through existing event mappings, preserving old-row edits without duplicating Matrix messages. Persistent cursors and mappings survive either service restarting. Restarting the bridge leaves the WeChat client and web UI running.

The bridge registers its bot and supplies the bundled WeChat avatar automatically at startup when no avatar is set. An existing custom avatar is preserved; a profile service failure does not stop bridging.

## Incoming messages

Incoming messages include text, replies, mentions, images, stickers/GIFs, cached MP4 video, voice decoded to WAV, files, locations, system notices, shared links, and WeChat Channels cards. Article cards include a compact thumbnail beside their title and description; Channels retain a video cover and show video only when the existing runtime can provide playable bytes. Cached names, avatars, group announcements, and rosters are mirrored.

Transfers and red packets are **read only**: Matrix receives a formatted card with the available amount, memo or greeting, and a read-only label. The bridge cannot collect a transfer or open a red packet. They can be quoted like other normal messages; system messages cannot be quoted. Card layouts use [Matrix-supported HTML](https://spec.matrix.org/v1.19/client-server-api/#mroommessage-msgtypes), with plain-text fallbacks and link-preview metadata for clients that support it; appearance varies by Matrix client.

Missing cached media produces a readable placeholder and is retried in rotating batches with persistent backoff from five seconds to five minutes. Retries continue indefinitely; verified cache-arrival notifications wake the matching message immediately. When an image has only a cached thumbnail, the bridge shows a labeled preview. After the runtime's native download validation succeeds, it requests missing image originals through WeChat's own coroutine queue. Once the original passes checksum verification, the bridge edits the existing Matrix message to include it, including after a bridge restart. Explicit revocations redact the corresponding Matrix event; disappearance from storage does not imply revocation.

## Outgoing messages

Outgoing support covers text, text replies, JPEG/PNG/GIF images, files, and MP4 through the existing file-upload route. Native acknowledgement is not delivery confirmation: the bridge waits for a matching source record with a server ID and suppresses its echo. Ambiguous or interrupted sends are reported as uncertain and are never automatically resubmitted, including when an API connection fails during a send.

Matrix emoji reactions are sent as quoted text replies containing the reaction emoji. The reacted-to message must have a confirmed WeChat message ID in that conversation.

## Limitations

Sticker/voice/location sending, native mention construction, native revocation, group/profile mutations, presence, encrypted Matrix rooms, and uncached video/file download initiation are unsupported. Unplayable Channels video remains a cover card. Leaving a Matrix room does not leave its WeChat group.

