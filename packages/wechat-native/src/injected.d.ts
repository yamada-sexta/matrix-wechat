import type { OutboundProfile, SessionProfile, StorageProfile } from "./profiles";

declare global {
  /** Provided by Runtime before evaluating instrument.ts in Frida, not by Bun. */
  const PROFILE: StorageProfile;
  const OUTBOUND: OutboundProfile;
  const SESSION: SessionProfile;
  const DOWNLOAD_ADAPTER: string;
  const QUERY_ADAPTER: string;
}
