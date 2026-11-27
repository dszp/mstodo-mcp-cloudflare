// The record sealed into the session cookie, and the device record that
// survives logout. All times are epoch seconds.

export type Session = {
  access_token: string;
  access_exp: number;
  refresh_token: string;
  cf_access_token?: string;
  cf_access_exp?: number;
  data_key: string;
  created_at: number;
  last_seen: number;
};

export type Device = { client_id: string; client_secret: string; server_origin: string };

export type SessionLimits = { maxHours: number; idleMinutes: number };

/** Seconds before access_exp at which the page is asked to refresh. */
const REFRESH_WINDOW_SEC = 60;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** unseal() only checks the ciphertext; the decrypted JSON still needs this shape check. */
export function isSession(v: unknown): v is Session {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    nonEmpty(s.access_token) &&
    nonEmpty(s.refresh_token) &&
    nonEmpty(s.data_key) &&
    Number.isFinite(s.access_exp) &&
    Number.isFinite(s.created_at) &&
    Number.isFinite(s.last_seen) &&
    (s.cf_access_token === undefined || typeof s.cf_access_token === "string") &&
    (s.cf_access_exp === undefined || Number.isFinite(s.cf_access_exp))
  );
}

export function isDevice(v: unknown): v is Device {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return nonEmpty(d.client_id) && nonEmpty(d.client_secret) && nonEmpty(d.server_origin);
}

export function sessionState(s: Session, now: number, limits: SessionLimits): "valid" | "refresh" | "expired" {
  // A malformed record would make every comparison below false, i.e. "valid".
  if (!isSession(s)) return "expired";
  if (now >= s.created_at + limits.maxHours * 3600) return "expired";
  if (now >= s.last_seen + limits.idleMinutes * 60) return "expired";
  if (s.cf_access_exp !== undefined && now >= s.cf_access_exp) return "expired";
  if (s.access_exp - now < REFRESH_WINDOW_SEC) return "refresh";
  return "valid";
}

/** A device cookie for another server counts as absent. */
export function deviceFor(device: Device | null, serverOrigin: string): Device | null {
  return device && device.server_origin === serverOrigin ? device : null;
}
