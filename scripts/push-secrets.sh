#!/usr/bin/env bash
# Push secrets from .dev.vars to Cloudflare via `wrangler secret put`.
#
# Each value is piped over stdin, so it never appears in argv, the process
# environment, the terminal scrollback, or any AI transcript that reads this
# session. Values are read only by wrangler and the script's local shell vars.
#
# Run from project root:    bash scripts/push-secrets.sh
# Or, after `chmod +x`:     ./scripts/push-secrets.sh
#
# Re-run any time .dev.vars changes — overwrites the deployed secret. Use
# `npx wrangler secret list` to verify what's currently set.

set -euo pipefail

DEV_VARS=".dev.vars"
if [[ ! -f "$DEV_VARS" ]]; then
  echo "error: $DEV_VARS not found. Run from project root." >&2
  exit 1
fi

# Keep in sync with .dev.vars.example. Order doesn't matter; we look each up.
SECRETS=(MS_TENANT_ID MS_CLIENT_ID MS_CLIENT_SECRET OWNER_EMAIL)

pushed=0
skipped=0
for name in "${SECRETS[@]}"; do
  # Extract the value after the first `=` on the first matching line.
  # Tolerates CRLF line endings.
  line=$(grep -E "^${name}=" "$DEV_VARS" | head -1 || true)
  value=${line#${name}=}
  value=${value%$'\r'}

  # Strip one pair of surrounding quotes, matching how wrangler parses
  # .dev.vars (dotenv). 1Password's "Copy Secret Reference" includes double
  # quotes, so this lets you paste it in verbatim; single quotes work too.
  if [[ ( "$value" == \"*\" || "$value" == \'*\' ) && ${#value} -ge 2 ]]; then
    value=${value#?}
    value=${value%?}
  fi

  # Resolve 1Password secret references (op://vault/item/field) via the `op`
  # CLI. Plain literal values pass through unchanged, so .dev.vars can mix
  # references and literals freely. `op read` needs an authenticated session
  # (`op signin`) or OP_SERVICE_ACCOUNT_TOKEN; the resolved value stays in a
  # local shell var and is piped over stdin like any other secret.
  if [[ "$value" == op://* ]]; then
    if ! command -v op >/dev/null 2>&1; then
      printf 'error: %s is a 1Password reference but the `op` CLI is not installed\n' "$name" >&2
      exit 1
    fi
    if ! value=$(op read "$value" 2>/dev/null); then
      printf 'error: failed to resolve %s from 1Password (signed in? run `op signin`)\n' "$name" >&2
      exit 1
    fi
  fi

  if [[ -z "$value" ]]; then
    printf 'skip: %s not set in %s\n' "$name" "$DEV_VARS" >&2
    skipped=$((skipped + 1))
    continue
  fi

  printf 'pushing %s… ' "$name"
  # printf -- not echo -- avoids interpreting a leading dash in the value.
  # No trailing newline; wrangler treats the whole stdin payload as the secret.
  if printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1; then
    printf 'ok\n'
    pushed=$((pushed + 1))
  else
    printf 'FAILED\n'
    printf 'rerun with stderr visible to debug:  printf "%%s" "$VAL" | npx wrangler secret put %s\n' "$name" >&2
    exit 1
  fi
done

printf '\ndone — %d pushed, %d skipped.\n' "$pushed" "$skipped"
printf 'verify with:  npx wrangler secret list\n'
