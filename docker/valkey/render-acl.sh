#!/bin/sh
# render-acl.sh — Valkey ACL entrypoint wrapper (ADR 0077 D4).
#
# Renders /etc/valkey/users.acl.template into /etc/valkey/users.acl using the
# required REDIS_PASSWORD / REDIS_READONLY_PASSWORD secrets, then execs the
# container command (valkey-server). Both secrets are required with no defaults;
# a missing secret fails the container loudly at boot, never with a known password.
#
# Substitution is literal (awk index/substr, not sed/gsub) so arbitrary passwords
# containing /, &, \, |, etc. render correctly. The rendered file is container-local
# only and must never be committed (see .gitignore).
set -eu

: "${REDIS_PASSWORD:?REDIS_PASSWORD is required (see .env.secrets.example)}"
: "${REDIS_READONLY_PASSWORD:?REDIS_READONLY_PASSWORD is required (see .env.secrets.example)}"

TEMPLATE="${ACL_TEMPLATE:-/etc/valkey/users.acl.template}"
OUTPUT="${ACL_OUTPUT:-/etc/valkey/users.acl}"

[ -f "$TEMPLATE" ] || { echo "render-acl: template not found at $TEMPLATE" >&2; exit 1; }
[ $# -gt 0 ] || { echo "render-acl: no command to exec (expected valkey-server …)" >&2; exit 1; }

# Literal placeholder replacement — no regex, no backreference expansion.
# Valkey's aclfile parser has no concept of comments: every non-blank line
# must start with the `user` keyword, and a `#`-prefixed line fails with
# "should start with user keyword followed by the username" (verified
# directly against valkey/valkey:7.2.8-alpine). Comment lines are dropped
# here so the tracked template can stay documented without breaking the
# rendered file Valkey actually loads.
awk '
  function replace_literal(haystack, needle, replacement,  result, i) {
    result = ""
    while ((i = index(haystack, needle)) > 0) {
      result = result substr(haystack, 1, i - 1) replacement
      haystack = substr(haystack, i + length(needle))
    }
    return result haystack
  }
  /^#/ { next }
  {
    line = replace_literal($0, "__REDIS_PASSWORD__", ENVIRON["REDIS_PASSWORD"])
    line = replace_literal(line, "__REDIS_READONLY_PASSWORD__", ENVIRON["REDIS_READONLY_PASSWORD"])
    print line
  }
' "$TEMPLATE" > "$OUTPUT.tmp"

# Safety: no placeholder may survive; output must define both users.
if grep -q "__REDIS_.*PASSWORD__" "$OUTPUT.tmp"; then
  echo "render-acl: rendered ACL still contains placeholder tokens" >&2
  exit 1
fi
if ! grep -q "^user default on >" "$OUTPUT.tmp"; then
  echo "render-acl: rendered ACL missing default user" >&2
  exit 1
fi
if ! grep -q "^user agent_readonly on >" "$OUTPUT.tmp"; then
  echo "render-acl: rendered ACL missing agent_readonly user" >&2
  exit 1
fi

# The image's own entrypoint (invoked below) drops from root to the `valkey`
# user for everything under its working directory, but this file lives at
# /etc/valkey — outside that directory — so it is never caught by the
# entrypoint's own chown pass. Without this, valkey-server aborts startup
# with "Error loading ACLs, opening file '/etc/valkey/users.acl':
# Permission denied" the moment it drops to the non-root `valkey` user.
if [ "$(id -u)" = '0' ] && getent passwd valkey >/dev/null 2>&1; then
  chown valkey:valkey "$OUTPUT.tmp"
fi
chmod 600 "$OUTPUT.tmp"
mv "$OUTPUT.tmp" "$OUTPUT"

# Preserve the image's own entrypoint when present (valkey/redis images ship
# docker-entrypoint.sh that prepares permissions before exec).
if [ -x /usr/local/bin/docker-entrypoint.sh ]; then
  exec /usr/local/bin/docker-entrypoint.sh "$@"
fi
exec "$@"
