import { APIError, type Message } from "wechat-rpc";

export type {
  Contact,
  Conversation,
  Event,
  Group,
  Message,
  Status,
} from "wechat-rpc";
export interface Asset {
  bytes: Buffer;
  type: string;
  name?: string;
  preview?: boolean;
}
export function checksum(bytes: Buffer) {
  return new Bun.CryptoHasher("md5").update(bytes).digest("hex");
}
export function sendFingerprint(message: Message): string {
  if (message.kind === "text")
    return JSON.stringify(["text", message.text || "", message.reply_to || ""]);
  return message.media?.checksum ? JSON.stringify(["attachment", message.media.checksum]) : "";
}
export function unsupported(operation: string): never {
  throw new APIError("unsupported", `${operation} is not supported by the current WeChat runtime`);
}
export const capabilities = {
  sending: [
    "text",
    "text reply",
    "Matrix reactions as emoji replies",
    "JPEG/PNG/GIF image",
    "file",
    "MP4 via file upload",
  ],
  receiving: [
    "text",
    "reply",
    "mention",
    "image",
    "sticker/GIF",
    "cached video",
    "voice/WAV",
    "file",
    "location",
    "link",
    "WeChat Channels cards and covers (video when playable)",
    "read-only transfers and red packets",
    "system",
    "revocation",
  ],
  unsupported: [
    "sticker sending",
    "voice/location sending",
    "native mention construction",
    "native revocation",
    "group/profile mutations",
    "presence",
    "uncached media downloads",
    "Matrix encryption",
  ],
  evidence:
    "Implementation availability is not proof of delivery. Group sends and sustained native reception still require live acceptance.",
};
