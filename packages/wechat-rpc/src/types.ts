export type Row = Record<string, any>;
export interface Contact {
  id: string;
  name: string;
  avatar?: string;
  native?: Row;
}
export interface Group extends Contact {
  topic?: string;
  members?: Contact[];
  joined?: boolean;
}
export interface Conversation {
  id: string;
  name?: string;
  chat_type: "direct" | "group";
  unread_count: number;
  last_timestamp: number;
}
export interface Message {
  id: string;
  local_key?: string;
  account_id: string;
  chat_id: string;
  chat_type: "direct" | "group";
  sender_id: string;
  kind: string;
  timestamp: number;
  own: boolean;
  text?: string;
  mentions?: string[];
  reply_to?: string;
  quote?: { sender_id: string; sender_name: string; text: string; type: number };
  link?: { url: string; title: string; description: string; source?: string; thumbnail?: boolean };
  read_only?: boolean;
  payment?: { title: string; amount?: string; description?: string };
  system?: { type: "payment_reminder" | "revocation" | "notice" };
  location?: { latitude: number; longitude: number; label: string };
  media?: {
    id: string;
    kind: string;
    state: string;
    name?: string;
    checksum?: string;
    size?: number;
    width?: number;
    height?: number;
    duration?: number;
  };
  native?: Row;
}
export interface Event {
  type: string;
  account_id?: string;
  chat_id?: string;
  message?: Message;
  data?: Row;
}
export interface ChangeCursor {
  epoch?: string;
  cursor?: number;
  wait_ms?: number;
}
export interface ChangeBatch {
  epoch: string;
  cursor: number;
  reset: boolean;
  events: Event[];
}
export interface Status {
  state:
    | "starting"
    | "signing_in"
    | "logging_out"
    | "awaiting_scan"
    | "awaiting_confirmation"
    | "logged_in"
    | "disconnected";
  account?: { id: string };
  error?: string;
}
export class APIError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function publicFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicFields) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !["native", "pid", "build_hash"].includes(k))
        .map(([k, v]) => [k, publicFields(v)]),
    ) as T;
  return value;
}

export function imageType(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  return undefined;
}
