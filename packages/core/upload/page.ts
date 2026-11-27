// Self-contained HTML upload page served at GET /upload. No external assets.
// It POSTs the chosen file(s) to /upload via fetch() with the signed link token.
//
// The page only works from a valid one-time link (`?t=<signed token>`): the
// token is scoped to a specific todo task and verified server-side. There is no
// generic/bearer mode — the bare page (no token) renders a disabled notice, and
// an invalid/expired/used link renders an error. A batch link (`&multi=1`) lets
// the user pick several files; a single-file link accepts exactly one.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 1.25rem; max-width: 640px; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  label { display: block; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  input[type=file] { width: 100%; box-sizing: border-box; padding: 0.6rem; font-size: 1rem; border: 1px solid #8884; border-radius: 8px; background: transparent; }
  button { margin-top: 1rem; padding: 0.7rem 1.2rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 8px; background: #6750f7; color: #fff; }
  button:disabled { opacity: 0.5; }
  .banner { margin: 0 0 1rem; padding: 0.7rem 0.9rem; border-radius: 8px; background: #6750f733; }
  .out { margin-top: 1.25rem; padding: 0.9rem; border-radius: 8px; background: #8881; white-space: pre-wrap; word-break: break-word; }
  .err { background: #f33a; }
  .muted { color: #8889; font-size: 0.85rem; }
  code { background: #8882; padding: 0.1rem 0.3rem; border-radius: 4px; }
</style>`;

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>${STYLE}
</head>
<body>
<h1>Attach to Microsoft To&nbsp;Do</h1>
${bodyHtml}
</body>
</html>`;
}

export interface UploadPageOptions {
  /** Human-readable task title, shown so the user can confirm the destination. */
  taskTitle?: string;
  /** Human-readable list name the task belongs to. */
  listName?: string;
  /** When set, the link stores the file under this exact name (single file). */
  filename?: string;
  /** Batch link — accept multiple files up to maxFiles. */
  multiple?: boolean;
  maxFiles?: number;
  /** When set, the link was invalid/expired/used — render a notice, no form. */
  linkError?: string;
  /** When set, no link token was supplied — render a disabled notice. */
  disabled?: boolean;
}

export function renderUploadPage(opts: UploadPageOptions = {}): string {
  if (opts.disabled) {
    return page(
      "Upload link required",
      `<div class="banner">This page needs a one-time upload link. Ask the assistant to create an upload link for the task you want to attach a file to.</div>`,
    );
  }
  if (opts.linkError) {
    return page(
      "Upload link unavailable",
      `<div class="banner err">This upload link is no longer usable (${escapeHtml(
        opts.linkError,
      )}). Upload links expire and work only once — ask for a fresh link.</div>`,
    );
  }

  const where = opts.taskTitle
    ? `<strong>${escapeHtml(opts.taskTitle)}</strong>`
    : "the selected task";
  const inList = opts.listName ? ` in <em>${escapeHtml(opts.listName)}</em>` : "";
  const dest = opts.filename
    ? `Uploading <code>${escapeHtml(opts.filename)}</code> to ${where}${inList}.`
    : `Uploading to ${where}${inList}${
        opts.multiple ? ` (up to ${opts.maxFiles ?? ""} files)` : ""
      }.`;

  return page(
    "Attach to Microsoft To Do",
    `<div class="banner">${dest}</div>
<form id="f">
  <label for="file">File${opts.multiple ? "s" : ""}</label>
  <input id="file" name="file" type="file"${opts.multiple ? " multiple" : ""} required>
  <button id="go" type="submit">Upload</button>
</form>
<div id="out" class="out" hidden></div>
<script>
  var params = new URLSearchParams(location.search);
  var linkToken = params.get('t');
  var form = document.getElementById('f');
  var out = document.getElementById('out');
  var go = document.getElementById('go');
  var fileInput = document.getElementById('file');

  function show(text, isErr) {
    out.hidden = false;
    out.className = 'out' + (isErr ? ' err' : '');
    out.textContent = text;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!linkToken) { show('Missing upload link token.', true); return; }
    if (!fileInput.files.length) { show('Pick a file first.', true); return; }
    var fd = new FormData();
    for (var i = 0; i < fileInput.files.length; i++) fd.append('file', fileInput.files[i]);
    fd.append('t', linkToken);

    go.disabled = true;
    show('Uploading…', false);
    try {
      var res = await fetch('/upload?t=' + encodeURIComponent(linkToken), { method: 'POST', body: fd });
      var json = await res.json();
      if (Array.isArray(json.files)) {
        var lines = json.files.map(function (f) {
          if (f.status === 'attached') return 'Attached: ' + f.name + '  (' + f.content_type + ', ' + f.size + ' bytes, ' + f.via + ')';
          if (f.status === 'duplicate') return 'Skipped (already attached): ' + f.name;
          return 'Failed: ' + f.name + '  (' + (f.reason || 'error') + ')';
        });
        show(lines.join('\\n'), !json.ok);
        if (json.ok) go.disabled = true;
      } else {
        show('Upload failed: ' + (json.reason || res.status) + '\\n' + JSON.stringify(json), true);
      }
    } catch (err) {
      show('Network error: ' + err, true);
      go.disabled = false;
    }
  });
</script>`,
  );
}
