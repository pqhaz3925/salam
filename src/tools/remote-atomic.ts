/** Executed only on the selected SSH target; Python 3's standard library supplies the syscall bridge. */
export const REMOTE_ATOMIC_SOURCE = String.raw`
import ctypes, errno, hashlib, json, os, shutil, signal, stat, sys, time

cancelled = False
RECOVERY_CAPACITY = 1024
UNPUBLISHED_RENAME_ERRORS = (errno.EACCES, errno.EEXIST, errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENOSYS, errno.ENOENT, errno.ENOTDIR, errno.EISDIR, errno.EXDEV, errno.ENOTEMPTY, errno.EPERM, errno.ENOSPC, errno.EDQUOT, errno.EBUSY, errno.EBADF, errno.ENAMETOOLONG, errno.ELOOP, errno.EROFS)

class MutationFailure(RuntimeError):
    def __init__(self, message, publication, paths=()):
        super().__init__(message)
        self.publication = publication
        self.paths = list(paths)

def emit(value):
    # A full upload can commit after SSH loses its channel. Output delivery is
    # not a commit condition; the client treats a lost terminal reply as unknown.
    try:
        print(value, flush=True)
    except (BrokenPipeError, OSError):
        pass

def cancel(signum, frame):
    global cancelled
    cancelled = True

for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(signum, cancel)

def check_cancel():
    if cancelled:
        raise RuntimeError("Interrupted before filesystem commit")

def expected(value, missing=True):
    if value == "missing" and missing:
        return None
    if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise RuntimeError("An explicit SHA256 expected hash (or missing for create-only) is required")
    return value

def mode_arg(value):
    return int(value, 8) if value else None

native = None

def ensure_supported():
    global native
    if native is not None:
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        fn = libc.renamex_np
        fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        native = lambda a, b, swap: fn(a, b, 2 if swap else 4)
    elif sys.platform.startswith("linux"):
        fn = libc.renameat2
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        native = lambda a, b, swap: fn(-100, a, -100, b, 2 if swap else 1)
    else:
        raise RuntimeError("Safe mutations require Darwin renamex_np or Linux renameat2; no ordinary-rename fallback")

def rename_atomic(source, target, exchange):
    ensure_supported()
    if native(os.fsencode(source), os.fsencode(target), exchange) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), source + " -> " + target)

def capture(path, backup=None, cancellable=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    out = None
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError(repr(path) + " is not a regular file")
        if backup is not None:
            out = open(backup, "xb")
            os.fchmod(out.fileno(), 0o600)
        digest = hashlib.sha256()
        size = 0
        while True:
            if cancellable:
                check_cancel()
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            if out is not None:
                out.write(chunk)
        after = os.fstat(fd)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError(repr(path) + " changed while its bytes were being preserved")
        if out is not None:
            out.flush()
            os.fchmod(out.fileno(), stat.S_IMODE(before.st_mode))
            os.fsync(out.fileno())
        return dict(hash=digest.hexdigest(), size=size, mode=stat.S_IMODE(before.st_mode), dev=before.st_dev, ino=before.st_ino)
    finally:
        if out is not None:
            out.close()
        os.close(fd)

def expect_file(path, digest, backup=None, expected_mode=None):
    if digest is None:
        if os.path.lexists(path):
            raise RuntimeError(repr(path) + " already exists; create-only mutation refused")
        return None
    if os.path.islink(path):
        raise RuntimeError(repr(path) + " is a symbolic link; refusing to change it")
    current = capture(path, backup, True)
    if current["hash"] != digest or (expected_mode is not None and current["mode"] != expected_mode):
        raise RuntimeError(repr(path) + " changed on disk; expected " + digest + ", found " + current["hash"])
    return current

def within(path, directory):
    return os.path.commonpath((path, directory)) == directory

def private_root(path, device):
    uid = os.getuid()
    current = "/"
    parts = [part for part in os.path.abspath(path).split("/") if part]
    for index, part in enumerate(parts):
        parent = os.lstat(current)
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid not in (uid, 0) or (parent.st_mode & 0o022 and not parent.st_mode & stat.S_ISVTX):
            raise RuntimeError("Recovery ancestor permits unsafe ownership or pathname substitution: " + repr(current))
        current = os.path.join(current, part)
        try:
            os.mkdir(current, 0o700)
        except FileExistsError:
            pass
        info = os.lstat(current)
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError("Recovery path is not a real directory; symlinks are refused: " + repr(current))
        if index == len(parts) - 1 and (info.st_uid != uid or info.st_mode & 0o077 or info.st_dev != device):
            raise RuntimeError("Recovery root must be owner-private (0700), owned by this uid, and on the destination filesystem: " + repr(current))
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        actual, named = os.fstat(fd), os.lstat(path)
        if actual.st_dev != device or actual.st_uid != uid or actual.st_mode & 0o077 or (named.st_dev, named.st_ino) != (actual.st_dev, actual.st_ino) or not stat.S_ISDIR(named.st_mode):
            raise RuntimeError("Recovery root changed while it was being opened: " + repr(path))
        return fd
    except Exception:
        os.close(fd)
        raise

def recovery(path, operation, digest):
    parent = os.path.realpath(os.path.dirname(path) or ".")
    device = os.lstat(parent).st_dev
    boundaries = [parent]
    workspace = os.environ.get("SALAM_WORKSPACE")
    if workspace:
        workspace = os.path.realpath(workspace)
        if within(parent, workspace):
            boundaries.append(workspace)
    mount = ancestor = parent
    while True:
        if os.path.lexists(os.path.join(ancestor, ".git")):
            boundaries.append(ancestor)
        above = os.path.dirname(ancestor)
        if above == ancestor or os.lstat(above).st_dev != device:
            break
        mount = ancestor = above
    home = os.path.realpath(os.path.expanduser("~"))
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.join(home, "Library/Caches" if sys.platform == "darwin" else ".cache")
    candidates = [os.path.join(cache, "salam", "recovery"), os.path.join(mount, ".salam-recovery-" + str(os.getuid()))]
    refused = []
    for root in candidates:
        root = os.path.normpath(root)
        if not os.path.isabs(root) or any(within(root, boundary) for boundary in boundaries):
            refused.append(root + ": inside the working tree")
            continue
        try:
            existing = root
            while not os.path.lexists(existing):
                existing = os.path.dirname(existing)
            if os.lstat(existing).st_dev != device:
                raise RuntimeError("different filesystem")
        except Exception as error:
            refused.append(root + ": " + str(error))
            continue
        fd = private_root(root, device)
        try:
            entries = set(os.listdir(root))
            for slot in range(RECOVERY_CAPACITY):
                name = "entry-" + str(slot)
                if name in entries:
                    continue
                actual, named = os.fstat(fd), os.lstat(root)
                if (named.st_dev, named.st_ino) != (actual.st_dev, actual.st_ino) or not stat.S_ISDIR(named.st_mode):
                    raise RuntimeError("Recovery root was substituted: " + repr(root))
                directory = os.path.join(root, name)
                try:
                    os.mkdir(directory, 0o700)
                except FileExistsError:
                    continue
                try:
                    descriptor = os.open(os.path.join(directory, "manifest.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(descriptor, "w") as manifest:
                        json.dump(dict(path=os.path.abspath(path), operation=operation, expectedHash=digest, createdAt=time.time(), retention="Retained inodes may still have open writers. No automatic pruning; inspect before manual removal."), manifest)
                        manifest.flush()
                        os.fsync(manifest.fileno())
                    emit("recovery\t" + json.dumps(directory))
                    return directory
                except Exception:
                    discard_staging(directory)
                    raise
            emit("recovery\t" + json.dumps(root))
            raise MutationFailure("Recovery capacity reached (" + str(RECOVERY_CAPACITY) + " retained operations) at " + root + ". No new staging was created. Inspect and manually remove only entries whose editor descriptors are closed and whose data is no longer needed; salam never prunes displaced inodes automatically.", "unpublished", [root])
        finally:
            os.close(fd)
    raise RuntimeError("No safe owner-private same-filesystem recovery location exists outside the working tree. " + "; ".join(refused))

def discard_staging(directory):
    if directory is None:
        return []
    try:
        shutil.rmtree(directory)
        emit("released\t" + json.dumps(directory))
        return []
    except FileNotFoundError:
        return []
    except OSError:
        return [directory]

def failure(error, paths, publication, note=""):
    paths = list(dict.fromkeys(list(paths) + getattr(error, "paths", [])))
    state = "Nothing was published." if publication == "unpublished" else "The mutation was rolled back; external changes were preserved." if publication == "rolled-back" else "Publication outcome is uncertain; inspect the destination before retrying."
    recovery_note = " Recovery paths outside the working tree (owner-private; never automatically pruned): " + ", ".join(repr(path) for path in paths) + ". Retained inodes may have live editor descriptors; inspect before manual removal." if paths else " Unpublished staging was removed."
    return MutationFailure(str(error) + ". " + state + " " + note + recovery_note, publication, paths)

def rollback_write(path, displaced, proposed):
    try:
        now = capture(path)
        if any(now[k] != proposed[k] for k in ("dev", "ino", "hash", "mode")):
            return "unknown", "Rollback left the destination alone because it changed again; displaced entry: " + repr(displaced)
        rename_atomic(displaced, path, True)
        try:
            again = capture(displaced)
        except Exception:
            again = {}
        if all(again.get(k) == proposed[k] for k in ("dev", "ino", "hash", "mode")):
            return "rolled-back", "Rollback restored the displaced inode itself; the previously published proposal remains at " + repr(displaced)
        return "unknown", "Rollback raced another save; its displaced inode remains at " + repr(displaced) + ", and the earlier displaced inode is back at " + repr(path)
    except Exception as error:
        return "unknown", "Rollback could not finish: " + str(error) + "; displaced entry remains at " + repr(displaced)

def write_atomic(path, digest, prepare, expected_mode=None, mode=None, payload=None):
    directory = None
    exchanged = False
    commit_attempted = False
    proposed = None
    try:
        check_cancel()
        ensure_supported()
        directory = recovery(path, "write", digest)
        displaced = os.path.join(directory, "displaced")
        original = expect_file(path, digest, os.path.join(directory, "before"), expected_mode)
        prepare(displaced)
        actual_mode = mode if mode is not None else (original["mode"] if original else None)
        if actual_mode is not None:
            os.chmod(displaced, actual_mode)
        proposed = capture(displaced, cancellable=True)
        if payload is not None and (proposed["size"], proposed["hash"]) != payload:
            raise RuntimeError("Remote payload byte count or SHA256 mismatch; refusing to publish incomplete or corrupted stdin")
        check_cancel()
        commit_attempted = True
        if digest is None:
            rename_atomic(displaced, path, False)
            discard_staging(directory)
            return proposed
        rename_atomic(displaced, path, True)
        exchanged = True
        actual = capture(displaced)
        if actual["hash"] != digest or actual["mode"] != original["mode"]:
            raise RuntimeError("An external version was displaced at commit; this write did not succeed")
        try:
            os.unlink(os.path.join(directory, "before"))
        except OSError:
            pass
        return dict(proposed, displaced=displaced, directory=directory)
    except Exception as error:
        uncertain = commit_attempted and not exchanged and getattr(error, "errno", None) not in UNPUBLISHED_RENAME_ERRORS
        publication, note = rollback_write(path, displaced, proposed) if exchanged else ("unknown" if uncertain else "unpublished", "")
        paths = [directory] if exchanged or uncertain else discard_staging(directory)
        raise failure(error, paths, publication, note) from error

def remove_atomic(path, digest, expected_mode=None):
    directory = None
    retired = False
    retire_attempted = False
    try:
        check_cancel()
        ensure_supported()
        directory = recovery(path, "remove", digest)
        displaced = os.path.join(directory, "displaced")
        original = expect_file(path, digest, os.path.join(directory, "before"), expected_mode)
        check_cancel()
        retire_attempted = True
        rename_atomic(path, displaced, False)
        retired = True
        actual = capture(displaced)
        if actual["hash"] != digest or actual["mode"] != original["mode"]:
            raise RuntimeError("An external version arrived before deletion")
        try:
            os.unlink(os.path.join(directory, "before"))
        except OSError:
            pass
        return directory
    except Exception as error:
        publication, note = ("unknown" if retire_attempted and getattr(error, "errno", None) not in UNPUBLISHED_RENAME_ERRORS else "unpublished"), ""
        if retired:
            publication = "unknown"
            try:
                rename_atomic(displaced, path, False)
                publication = "rolled-back"
                note = "The displaced inode itself was put back using create-if-absent"
            except Exception as rollback_error:
                note = "Rollback did not overwrite the destination: " + str(rollback_error) + "; displaced inode: " + repr(displaced)
        paths = [directory] if publication == "unknown" else discard_staging(directory)
        raise failure(error, paths, publication, note) from error

def copy_prepare(source):
    def prepare(target):
        capture(source, target, True)
    return prepare

def move_atomic(source, target, source_hash, target_hash, source_mode=None, target_mode=None):
    global cancelled
    directory = None
    publication = "unpublished"
    try:
        check_cancel()
        ensure_supported()
        directory = recovery(source, "move", source_hash)
        before_source = os.path.join(directory, "source-before")
        first = expect_file(source, source_hash, before_source, source_mode)
        expect_file(target, target_hash, expected_mode=target_mode)
        if source == target:
            discard_staging(directory)
            return first
        try:
            written = write_atomic(target, target_hash, copy_prepare(before_source), target_mode, first["mode"])
        except Exception as error:
            publication = getattr(error, "publication", "unknown")
            raise
        publication = "unknown"
        try:
            remove_atomic(source, source_hash, first["mode"])
        except Exception as error:
            cancelled = False  # Finish conditional rollback even after cancellation.
            destination_recovery = [written["directory"]] if "directory" in written else []
            if "displaced" in written:
                rolled, note = rollback_write(target, written["displaced"], written)
            else:
                try:
                    retired = remove_atomic(target, written["hash"], written["mode"])
                    destination_recovery.append(retired)
                    rolled, note = "rolled-back", "The completed create-only destination was conditionally retired; its previously published inode remains at " + repr(retired)
                except Exception as rollback_error:
                    raise failure(rollback_error, [directory] + destination_recovery + getattr(error, "paths", []), "unknown", "Source retirement failed: " + str(error)) from error
            publication = "rolled-back" if getattr(error, "publication", "unknown") != "unknown" and rolled == "rolled-back" else "unknown"
            raise failure(error, destination_recovery, publication, note) from error
        discard_staging(directory)
        return written
    except Exception as error:
        raise failure(error, [directory] if publication == "unknown" and directory else discard_staging(directory), publication) from error

def mkdir_atomic(path, mode):
    directory = None
    attempted = False
    try:
        check_cancel()
        ensure_supported()
        directory = recovery(path, "mkdir", None)
        stage = os.path.join(directory, "directory")
        os.mkdir(stage, 0o777 if mode is None else mode)
        if mode is not None:
            os.chmod(stage, mode)
        actual_mode = stat.S_IMODE(os.lstat(stage).st_mode)
        check_cancel()
        attempted = True
        rename_atomic(stage, path, False)
        discard_staging(directory)
        emit("kind\tdir\nmode\t" + format(actual_mode, "o"))
    except Exception as error:
        uncertain = attempted and getattr(error, "errno", None) not in UNPUBLISHED_RENAME_ERRORS
        raise failure(error, [directory] if uncertain else discard_staging(directory), "unknown" if uncertain else "unpublished") from error

def rmdir_atomic(path, mode):
    directory = None
    retired = attempted = False
    try:
        check_cancel()
        ensure_supported()
        before = os.lstat(path)
        if not stat.S_ISDIR(before.st_mode) or (mode is not None and stat.S_IMODE(before.st_mode) != mode):
            raise RuntimeError("Not the expected real directory: " + repr(path))
        if os.listdir(path):
            raise RuntimeError("Directory is not empty; refusing unreviewed descendants: " + repr(path))
        directory = recovery(path, "rmdir", None)
        displaced = os.path.join(directory, "displaced")
        check_cancel()
        attempted = True
        rename_atomic(path, displaced, False)
        retired = True
        after = os.lstat(displaced)
        if not stat.S_ISDIR(after.st_mode) or (before.st_dev, before.st_ino, before.st_mode) != (after.st_dev, after.st_ino, after.st_mode) or os.listdir(displaced):
            raise RuntimeError("Directory changed before retirement: " + repr(path))
    except Exception as error:
        publication, note = ("unknown" if attempted and getattr(error, "errno", None) not in UNPUBLISHED_RENAME_ERRORS else "unpublished"), ""
        if retired:
            publication = "unknown"
            try:
                rename_atomic(displaced, path, False)
                publication = "rolled-back"
            except Exception as rollback_error:
                note = "Directory rollback refused replacement: " + str(rollback_error)
        raise failure(error, [directory] if publication == "unknown" else discard_staging(directory), publication, note) from error

def confirm(value):
    emit("hash\t" + value["hash"] + "\nsize\t" + str(value["size"]) + "\nmode\t" + format(value["mode"], "o"))

def main():
    command, path = sys.argv[1:3]
    if command == "read":
        count, offset = int(sys.argv[3]), int(sys.argv[4])
        if count < 0 or offset < 0:
            raise RuntimeError("Read offset and limit must be non-negative")
        with open(path, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise RuntimeError("Not a regular file: " + repr(path))
            source.seek(offset)
            while count:
                check_cancel()
                chunk = source.read(min(count, 65536))
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
                count -= len(chunk)
        return
    if command == "entries":
        if not stat.S_ISDIR(os.lstat(path).st_mode):
            raise RuntimeError("Not a real directory: " + repr(path))
        emit(json.dumps([dict(path=os.path.join(path, name), kind="dir" if stat.S_ISDIR(os.lstat(os.path.join(path, name)).st_mode) else "file") for name in sorted(os.listdir(path))]))
    elif command == "mkdir":
        mkdir_atomic(path, mode_arg(sys.argv[3]))
    elif command == "rmdir":
        rmdir_atomic(path, mode_arg(sys.argv[3]))
    elif command == "dirmode":
        mode, guard_mode = int(sys.argv[3], 8), mode_arg(sys.argv[4])
        fd = None
        changed = False
        try:
            if mode < 0 or mode > 0o7777:
                raise RuntimeError("Invalid directory mode")
            check_cancel()
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode) or (guard_mode is not None and stat.S_IMODE(info.st_mode) != guard_mode):
                raise RuntimeError("Not the expected directory: " + repr(path))
            check_cancel()
            os.fchmod(fd, mode)
            changed = True
        except Exception as error:
            raise failure(error, [], "unknown" if changed else "unpublished") from error
        finally:
            if fd is not None:
                os.close(fd)
    elif command == "write":
        digest, guard_mode = expected(sys.argv[3]), mode_arg(sys.argv[4])
        payload_size, payload_hash = int(sys.argv[6]), expected(sys.argv[7], False)
        if payload_size < 0:
            raise RuntimeError("Payload byte count must be non-negative")
        def prepare(stage):
            with open(stage, "xb") as output:
                remaining = payload_size
                while remaining:
                    check_cancel()
                    chunk = sys.stdin.buffer.read(min(remaining, 65536))
                    if not chunk:
                        raise RuntimeError("Remote payload ended before its exact byte count; nothing will be published")
                    output.write(chunk)
                    remaining -= len(chunk)
                if sys.stdin.buffer.read(1):
                    raise RuntimeError("Remote payload exceeds its exact byte count; nothing will be published")
                output.flush()
                os.fsync(output.fileno())
        confirm(write_atomic(path, digest, prepare, guard_mode, mode_arg(sys.argv[5]), (payload_size, payload_hash)))
    elif command == "remove":
        remove_atomic(path, expected(sys.argv[3], False), mode_arg(sys.argv[4]))
    elif command == "move":
        target = sys.argv[3]
        confirm(move_atomic(path, target, expected(sys.argv[4], False), expected(sys.argv[5]), mode_arg(sys.argv[6]), mode_arg(sys.argv[7])))
    elif command == "chmod":
        mode, digest = int(sys.argv[3], 8), expected(sys.argv[4], False)
        guard_mode = mode_arg(sys.argv[5])
        if mode < 0 or mode > 0o7777:
            raise RuntimeError("File mode must be between 0 and 07777")
        fd = None
        changed = False
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                raise RuntimeError("Not a regular file: " + repr(path))
            if guard_mode is not None and stat.S_IMODE(before.st_mode) != guard_mode:
                raise RuntimeError(repr(path) + " permissions changed before its mode could be restored")
            hasher = hashlib.sha256()
            size = 0
            while True:
                check_cancel()
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                hasher.update(chunk)
                size += len(chunk)
            after = os.fstat(fd)
            if hasher.hexdigest() != digest or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise RuntimeError(repr(path) + " changed before its mode could be restored")
            check_cancel()
            os.fchmod(fd, mode)
            changed = True
            confirm(dict(hash=digest, size=size, mode=mode))
        except Exception as error:
            raise failure(error, [], "unknown" if changed else "unpublished") from error
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except Exception as error:
                    raise failure(error, [], "unknown" if changed else "unpublished") from error
    else:
        raise RuntimeError("Unknown atomic helper command: " + command)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("publication\t" + getattr(error, "publication", "unpublished"))
        print("Cannot safely complete filesystem operation: " + str(error) + ". Inspect the destination and reported recovery paths before retrying.", file=sys.stderr)
        sys.exit(2)
`;
