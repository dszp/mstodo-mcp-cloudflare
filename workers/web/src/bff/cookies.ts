// Cookie helpers. Every cookie is `__Host-` scoped: Path=/, Secure, no Domain.

// Browsers silently drop a cookie over about 4096 bytes, which would look like
// a sign-out loop. Fail loudly well under that.
const MAX_VALUE_BYTES = 4000;

const ATTRIBUTES = ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"];

export function cookieHeader(name: string, value: string, maxAgeSec: number): string {
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) {
    throw new Error(`cookie ${name} exceeds ${MAX_VALUE_BYTES} bytes`);
  }
  return [`${name}=${value}`, ...ATTRIBUTES, `Max-Age=${Math.floor(maxAgeSec)}`].join("; ");
}

export function clearCookie(name: string): string {
  return [`${name}=`, ...ATTRIBUTES, "Max-Age=0"].join("; ");
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export const SESSION_COOKIE = "__Host-potem-session";
/** The browser's OAuth client registration; kept across logout. */
export const DEVICE_COOKIE = "__Host-potem-device";
/** The state of one sign-in between /auth/login and /auth/callback. */
export const LOGIN_COOKIE = "__Host-potem-login";
