import { REMOTE_ATOMIC_SOURCE } from "./remote-atomic.ts";
import { sha256Hex, shellQuote } from "./util.ts";

/**
 * The payload installed on every SSH target. Metadata/list operations use POSIX
 * sh; bounded seek reads and guarded mutations require Python 3. Atomic rename
 * flags come from the target's libc (Darwin/Linux), never a local fallback.
 *
 * Responsibilities kept here rather than in ad-hoc ssh command strings:
 *   - expected-hash exchange/create-only writes with retained recovery versions
 *   - one sha256 implementation regardless of sha256sum/shasum/openssl
 *   - stat normalisation across GNU `stat -c` and BSD `stat -f`
 *   - a single round trip for stat+hash, which dominates remote latency
 */
export const REMOTE_HELPER_SOURCE = `#!/bin/sh
# salam remote helper. Installed by the salam harness; safe to delete.
set -u

die() { printf '%s\\n' "$*" >&2; exit 2; }

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "no sha256 implementation found (need sha256sum, shasum or openssl)"
  fi
}

file_mode() {
  m=$(stat -c '%a' "$1" 2>/dev/null) || m=$(python3 -c 'import os,stat,sys; print(format(stat.S_IMODE(os.stat(sys.argv[1]).st_mode), "o"))' "$1" 2>/dev/null) || m=''
  printf '%s' "$m"
}

cmd=\${1:-}
[ "$#" -gt 0 ] && shift

case "$cmd" in
  version)
    printf 'salam-helper\\n'
    ;;
  probe)
    printf 'uname\\t%s\\n' "$(uname -s)"
    printf 'arch\\t%s\\n' "$(uname -m)"
    printf 'home\\t%s\\n' "\${HOME:-}"
    for t in rg ast-grep sg git bash python3 sha256sum shasum base64 find head; do
      p=$(command -v "$t" 2>/dev/null) || p=''
      printf 'bin\\t%s\\t%s\\n' "$t" "$p"
    done
    ;;
  stat)
    p=\${1:?path required}
    [ -L "$p" ] && printf 'symlink\\t1\\n'
    if [ -d "$p" ]; then kind=dir
    elif [ -f "$p" ]; then kind=file
    elif [ -e "$p" ]; then kind=other
    else printf 'kind\\tmissing\\n'; exit 0
    fi
    if size=$(stat -c '%s' "$p" 2>/dev/null); then
      mtime=$(stat -c '%Y' "$p" 2>/dev/null)
    else
      size=$(stat -f '%z' "$p" 2>/dev/null) || size=0
      mtime=$(stat -f '%m' "$p" 2>/dev/null) || mtime=0
    fi
    printf 'kind\\t%s\\nsize\\t%s\\nmtime\\t%s\\nmode\\t%s\\n' "$kind" "$size" "$mtime" "$(file_mode "$p")"
    if [ "$kind" = file ] && [ "\${2:-}" != nohash ]; then
      limit=\${3:-}
      if [ -z "$limit" ] || [ "$size" -le "$limit" ]; then
        printf 'hash\\t%s\\n' "$(hash_file "$p")"
      fi
    fi
    ;;
  hash)
    p=\${1:?path required}
    [ -f "$p" ] || die "not a file: $p"
    hash_file "$p"
    ;;
  read|write|remove|chmod|move|mkdir|rmdir|dirmode|entries)
    command -v python3 >/dev/null 2>&1 || die "safe file operations require Python 3 on this SSH target; nothing was changed"
    exec python3 -c ${shellQuote(REMOTE_ATOMIC_SOURCE)} "$cmd" "$@"
    ;;
  list)
    p=\${1:?path required}
    depth=\${2:-1}
    hidden=\${3:-0}
    [ -d "$p" ] || die "not a directory: $p"
    TAB=$(printf '\\t')
    if [ "$hidden" = 1 ]; then
      find "$p" -mindepth 1 -maxdepth "$depth" -type d -print 2>/dev/null | sed "s|^|d\${TAB}|"
      find "$p" -mindepth 1 -maxdepth "$depth" ! -type d -print 2>/dev/null | sed "s|^|f\${TAB}|"
    else
      find "$p" -mindepth 1 -maxdepth "$depth" -name '.*' -prune -o -type d -print 2>/dev/null | sed "s|^|d\${TAB}|"
      find "$p" -mindepth 1 -maxdepth "$depth" -name '.*' -prune -o ! -type d -print 2>/dev/null | sed "s|^|f\${TAB}|"
    fi
    ;;
  *)
    die "unknown helper command: $cmd"
    ;;
esac
`;

/**
 * Content-addressed version. Editing the payload changes the install path, so a
 * target never runs a stale helper and upgrades need no invalidation protocol.
 */
export const REMOTE_HELPER_VERSION = sha256Hex(REMOTE_HELPER_SOURCE).slice(0, 12);
export const REMOTE_HELPER_FILENAME = `helper-${REMOTE_HELPER_VERSION}.sh`;
