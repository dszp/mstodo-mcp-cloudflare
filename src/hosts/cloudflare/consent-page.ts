import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

// The per-client consent page shown on /authorize before the Microsoft sign-in
// (MCP confused-deputy mitigation). Everything about the client — name, URI,
// redirect host — comes from dynamic registration, so an attacker chooses it:
// escape all of it. The library's beginConsent() headers forbid framing.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 1.25rem; max-width: 560px; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  .card { padding: 0.9rem 1rem; border-radius: 8px; background: #8881; margin: 0 0 1rem; }
  .warn { padding: 0.7rem 0.9rem; border-radius: 8px; background: #f903; margin: 0 0 1rem; }
  .muted { color: #8889; font-size: 0.9rem; }
  button { padding: 0.7rem 1.2rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 8px; margin-right: 0.5rem; }
  .approve { background: #6750f7; color: #fff; }
  .deny { background: #8883; color: inherit; }
  code { background: #8882; padding: 0.1rem 0.3rem; border-radius: 4px; word-break: break-all; }
</style>`;

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>${STYLE}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName || "An unnamed app");
  const host = escapeHtml(details.redirectHost);
  const publisher = details.clientDomain
    ? `<p>Published by <strong>${escapeHtml(details.clientDomain)}</strong>.</p>`
    : `<p class="muted">This app registered itself, so its name isn't verified. Check the address below instead.</p>`;
  const loopback = details.redirectIsLoopback
    ? `<div class="warn"><strong>Access goes to an app on your computer.</strong> Allow it only if you just started connecting from that app.</div>`
    : "";
  return page(
    `Allow ${details.clientName || "this app"}?`,
    `<h1>Allow ${name} to use your Microsoft To&nbsp;Do?</h1>
<div class="card">
  ${publisher}
  <p>Access will be sent to <strong>${host}</strong></p>
  <p class="muted">Full address: <code>${escapeHtml(details.redirectUri)}</code></p>
</div>
${loopback}
<p>The app will be able to read, create, change and delete your tasks and lists. Allow it only if you just connected it yourself.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p><label><input type="checkbox" name="remember" value="1" checked> Don't ask again for this app in this browser for 30 days</label></p>
  <p>
    <button class="approve" name="decision" value="approve">Allow and sign in to Microsoft</button>
    <button class="deny" name="decision" value="deny">Deny</button>
  </p>
</form>`,
  );
}

export function errorPage(title: string, message: string, status: number): Response {
  return new Response(page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
  });
}
