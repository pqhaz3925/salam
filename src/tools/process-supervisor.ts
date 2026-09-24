import { sha256Hex } from "./util.ts";

/** Python is already the SSH filesystem prerequisite. This helper is independent
 * of remote-helper.ts: every command has a private, authenticated supervisor,
 * never a pid-file kill channel. Its guardian pins the process-group identity
 * until teardown is observed and reaped. */
export const PROCESS_SUPERVISOR_SOURCE = String.raw`
import os, sys, json, socket, select, signal, subprocess, time, base64, codecs, collections, errno, fcntl, termios, struct, unicodedata, shutil

LIMIT = 1048576
OWNED_GUARDIAN = None

def units(s):
    return len(s.encode('utf-16-le')) // 2

class Screen:
    """Cell terminal with incremental VT parsing, scroll regions and alternate screen."""
    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.lines = [[' '] * cols for _ in range(rows)]
        self.x = self.y = 0
        self.saved = (0, 0)
        self.top, self.bottom = 0, rows - 1
        self.state, self.sequence = 'text', ''
        self.alternate = None
        self.wrap = True
        self.pending_wrap = False
        self.origin = False
        self.insert = False
        self.visible = True
        self.tabs = set(range(8, cols, 8))
        self.charset = False
        self.special = False

    def resize(self, cols, rows):
        def sized(lines):
            return [(row[:cols] + [' '] * cols)[:cols] for row in lines[:rows]] + [[' '] * cols for _ in range(max(0, rows - len(lines)))]
        self.lines = sized(self.lines)
        if self.alternate is not None:
            lines, x, y = self.alternate
            self.alternate = (sized(lines), min(x, cols - 1), min(y, rows - 1))
        self.cols, self.rows = cols, rows
        self.x, self.y = min(self.x, cols - 1), min(self.y, rows - 1)
        self.saved = (min(max(0, self.saved[0]), cols - 1), min(max(0, self.saved[1]), rows - 1))
        self.top, self.bottom = 0, rows - 1
        self.tabs = set(range(8, cols, 8))
        self.pending_wrap = False

    def scroll(self, count=1):
        for _ in range(min(abs(count), self.bottom - self.top + 1)):
            if count > 0:
                del self.lines[self.top]
                self.lines.insert(self.bottom, [' '] * self.cols)
            else:
                del self.lines[self.bottom]
                self.lines.insert(self.top, [' '] * self.cols)

    def newline(self):
        if self.y == self.bottom: self.scroll()
        else: self.y = min(self.rows - 1, self.y + 1)
        self.pending_wrap = False

    def csi(self, seq, final):
        private = seq.startswith('?')
        raw = seq.lstrip('?=>!').split(';')
        try: p = [int(v or 0) for v in raw]
        except ValueError: return
        n = p[0] or 1
        lo, hi = (self.top, self.bottom) if self.origin else (0, self.rows - 1)
        if final in 'Hf':
            self.y = max(lo, min(hi, (p[0] or 1) - 1 + (self.top if self.origin else 0)))
            self.x = max(0, min(self.cols - 1, (p[1] if len(p) > 1 and p[1] else 1) - 1))
        elif final == 'A': self.y = max(lo, self.y - n)
        elif final in 'Be': self.y = min(hi, self.y + n)
        elif final in 'Ca': self.x = min(self.cols - 1, self.x + n)
        elif final == 'D': self.x = max(0, self.x - n)
        elif final == 'E': self.y, self.x = min(hi, self.y + n), 0
        elif final == 'F': self.y, self.x = max(lo, self.y - n), 0
        elif final in 'G\x60': self.x = min(self.cols - 1, n - 1)
        elif final == 'd': self.y = max(lo, min(hi, n - 1 + (self.top if self.origin else 0)))
        elif final == 'J':
            if p[0] in (2, 3): self.lines = [[' '] * self.cols for _ in range(self.rows)]
            elif p[0] == 0:
                self.lines[self.y][self.x:] = [' '] * (self.cols - self.x)
                for y in range(self.y + 1, self.rows): self.lines[y] = [' '] * self.cols
            elif p[0] == 1:
                for y in range(self.y): self.lines[y] = [' '] * self.cols
                self.lines[self.y][:self.x + 1] = [' '] * (self.x + 1)
        elif final == 'K':
            start, end = (0, self.cols) if p[0] == 2 else ((0, self.x + 1) if p[0] == 1 else (self.x, self.cols))
            self.lines[self.y][start:end] = [' '] * (end - start)
        elif final == 'X': self.lines[self.y][self.x:min(self.cols, self.x + n)] = [' '] * min(n, self.cols - self.x)
        elif final == 'P':
            row = self.lines[self.y]
            del row[self.x:self.x + n]
            row.extend([' '] * (self.cols - len(row)))
        elif final == '@':
            row = self.lines[self.y]
            row[self.x:self.x] = [' '] * min(n, self.cols)
            del row[self.cols:]
        elif final in 'LM' and self.top <= self.y <= self.bottom:
            for _ in range(min(n, self.bottom - self.y + 1)):
                if final == 'L':
                    del self.lines[self.bottom]
                    self.lines.insert(self.y, [' '] * self.cols)
                else:
                    del self.lines[self.y]
                    self.lines.insert(self.bottom, [' '] * self.cols)
        elif final in 'ST': self.scroll(n if final == 'S' else -n)
        elif final == 'r' and not private:
            top, bottom = n - 1, (p[1] if len(p) > 1 and p[1] else self.rows) - 1
            if 0 <= top < bottom < self.rows:
                self.top, self.bottom = top, bottom
                self.x, self.y = 0, top if self.origin else 0
        elif final == 's': self.saved = (self.x, self.y)
        elif final == 'u': self.x, self.y = self.saved
        elif final == 'g':
            if p[0] == 3: self.tabs.clear()
            elif p[0] == 0: self.tabs.discard(self.x)
        elif final in 'hl':
            enabled = final == 'h'
            for mode in p:
                if private and mode in (47, 1047, 1049):
                    if enabled and self.alternate is None:
                        self.alternate = (self.lines, self.x, self.y)
                        self.lines = [[' '] * self.cols for _ in range(self.rows)]
                        self.x = self.y = 0
                    elif not enabled and self.alternate is not None:
                        self.lines, self.x, self.y = self.alternate
                        self.alternate = None
                elif private and mode == 6: self.origin = enabled; self.x, self.y = 0, self.top if enabled else 0
                elif private and mode == 7: self.wrap = enabled
                elif private and mode == 25: self.visible = enabled
                elif not private and mode == 4: self.insert = enabled
        self.x, self.y = min(self.cols - 1, max(0, self.x)), min(self.rows - 1, max(0, self.y))
        if final not in 'mhln': self.pending_wrap = False

    def feed(self, text):
        replies = []
        graphics = dict(zip('jklmnopqrstuvwx', '┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│'))
        for ch in text:
            if self.state == 'charset':
                self.special = ch == '0'; self.state = 'text'; continue
            if self.state == 'osc':
                if ch == '\x07': self.state = 'text'
                elif ch == '\x1b': self.state = 'osc-end'
                continue
            if self.state == 'osc-end':
                self.state = 'text' if ch == '\\' else 'osc'; continue
            if self.state == 'escape':
                self.state = 'text'
                if ch == '[': self.state, self.sequence = 'csi', ''
                elif ch in ']P^_': self.state = 'osc'
                elif ch in '()*+': self.state = 'charset'
                elif ch == '7': self.saved = (self.x, self.y)
                elif ch == '8': self.x, self.y = min(self.cols - 1, max(0, self.saved[0])), min(self.rows - 1, max(0, self.saved[1]))
                elif ch == 'D': self.newline()
                elif ch == 'E': self.x = 0; self.newline()
                elif ch == 'M':
                    if self.y == self.top: self.scroll(-1)
                    else: self.y = max(0, self.y - 1)
                elif ch == 'H': self.tabs.add(self.x)
                elif ch == 'c': self.__init__(self.cols, self.rows)
                continue
            if self.state == 'csi':
                if '@' <= ch <= '~':
                    if ch == 'n' and self.sequence == '6': replies.append('\x1b[%d;%dR' % (self.y + 1, self.x + 1))
                    elif ch == 'n' and self.sequence == '5': replies.append('\x1b[0n')
                    elif ch == 'c': replies.append('\x1b[?1;2c')
                    else: self.csi(self.sequence, ch)
                    self.state = 'text'
                elif len(self.sequence) < 256: self.sequence += ch
                else: self.state = 'text'
                continue
            if ch == '\x1b': self.state = 'escape'
            elif ch == '\r': self.x = 0; self.pending_wrap = False
            elif ch in '\n\v\f': self.newline()
            elif ch == '\b': self.x = max(0, self.x - 1); self.pending_wrap = False
            elif ch == '\t': self.x = min((t for t in self.tabs if t > self.x), default=self.cols - 1)
            elif ch >= ' ' and ch != '\x7f':
                if unicodedata.combining(ch):
                    x = self.x if self.pending_wrap else max(0, self.x - 1)
                    if self.lines[self.y][x] == '' and x: x -= 1
                    self.lines[self.y][x] += ch
                    continue
                if self.special: ch = graphics.get(ch, ch)
                width = 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1
                if self.wrap and (self.pending_wrap or self.x + width > self.cols): self.x = 0; self.newline()
                if self.insert:
                    self.lines[self.y][self.x:self.x] = [' '] * width
                    del self.lines[self.y][self.cols:]
                row = self.lines[self.y]
                if row[self.x] == '' and self.x: row[self.x - 1] = ' '
                if self.x + 1 < self.cols and row[self.x + 1] == '': row[self.x + 1] = ' '
                if width == 2 and self.x + 2 < self.cols and row[self.x + 2] == '': row[self.x + 2] = ' '
                self.lines[self.y][self.x] = ch
                if width == 2 and self.x + 1 < self.cols: self.lines[self.y][self.x + 1] = ''
                self.pending_wrap = self.x + width >= self.cols
                self.x = min(self.cols - 1, self.x + width)
        return ''.join(replies).encode()

    def snapshot(self):
        return {'text': '\n'.join(''.join(row).rstrip() for row in self.lines), 'cols': self.cols, 'rows': self.rows, 'cursorX': self.x, 'cursorY': self.y, 'cursorVisible': self.visible, 'alternate': self.alternate is not None}

def atomic(path, value):
    temp = path + '.tmp'
    with open(temp, 'w') as f:
        json.dump(value, f, ensure_ascii=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)

def private_root(root):
    os.makedirs(root, mode=0o700, exist_ok=True)
    st = os.lstat(root)
    if st.st_uid != os.getuid() or not __import__('stat').S_ISDIR(st.st_mode) or st.st_mode & 0o077: raise ValueError('Unsafe supervisor directory')
    return root

def location(key):
    if len(key) != 40 or any(c not in '0123456789abcdef' for c in key): raise ValueError('Invalid supervisor identity')
    root = private_root(os.path.join(os.path.expanduser('~'), '.cache', 'salam', 'processes'))
    return os.path.join(root, key)

def control_path(key):
    # Only the socket needs a short sockaddr_un path; completed output is durable.
    root = private_root(os.path.join('/tmp', 'salam-process-' + str(os.getuid())))
    return os.path.join(root, key + '.sock')

class SupervisorFailure(Exception):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code

def rpc(key, request):
    path = location(key)
    request['key'] = key
    try:
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(40)
            s.connect(control_path(key))
            s.sendall(json.dumps(request).encode() + b'\n')
            chunks = []
            while True:
                chunk = s.recv(65536)
                if not chunk: break
                chunks.append(chunk)
            response = json.loads(b''.join(chunks))
    except (ConnectionRefusedError, FileNotFoundError):
        if not os.path.isdir(path):
            return {'state': 'exited', 'code': 127, 'pid': None, 'start': 0, 'cursor': 0, 'byteStart': 0, 'byteCursor': 0, 'chunks': [], 'screen': None, 'timedOut': False, 'aborted': False, 'terminationConfirmed': True, 'neverStarted': True, 'spawnError': 'Supervisor was never started'}
        with open(path + '/owner', 'a') as lease:
            try: fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise SupervisorFailure('Supervisor is starting or reconnecting', 'retry')
            try:
                with open(path + '/state') as f: response = json.load(f)
            except FileNotFoundError: response = {'state': 'running'}
            if response.get('state') == 'running':
                raise SupervisorFailure('Owned supervisor is dead; process-tree termination cannot be confirmed', 'dead')
            if 'wireCursor' in request:
                acknowledged = request['wireCursor']
                if not response.get('wireStart', 0) <= acknowledged <= response.get('wireCursor', 0): raise ValueError('Invalid protocol acknowledgement')
                response['wire'] = [chunk for chunk in response.get('wire', []) if chunk['end'] > acknowledged]
                response['wireStart'] = acknowledged
                atomic(path + '/state', response)
            if request['op'] == 'forget':
                if response.get('terminationConfirmed') is not True: raise ValueError('Cannot forget unconfirmed ownership')
                if response.get('wireCursor', 0) > request.get('wireCursor', 0): raise ValueError('Protocol output is not acknowledged')
                shutil.rmtree(path)
                return {'forgotten': True}
            if request['op'] not in ('status', 'wait', 'screen', 'stop'): raise ValueError('Command is no longer running')
    if 'error' in response: raise SupervisorFailure(response['error'], response.get('errorCode', 'request'))
    return response

def session_members(anchor):
    # Darwin's ps sess column is a kernel pointer and can be redacted to zero.
    # getsid reports the real session identity; never infer ownership from ps sess.
    # The guardian established setsid(), so its PID is the pinned SID. On
    # Darwin getsid(anchor) may fail once that unreaped anchor is a zombie.
    identity = anchor
    result = subprocess.run(['ps', '-eo', 'pid=,pgid=,stat='], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
    if result.returncode: raise RuntimeError('Cannot inspect owned session teardown')
    members = []
    for row in (line.split() for line in result.stdout.decode().splitlines()):
        if len(row) != 3 or int(row[0]) <= 0 or row[2].startswith('Z'): continue
        try:
            if os.getsid(int(row[0])) == identity: members.append(row)
        except ProcessLookupError: pass
    return members

def signal_session(sig):
    # Called INSIDE the owned session. Joining each group pins its identity:
    # setpgid refuses groups that vanished or moved outside our session.
    anchor = os.getpid()
    while True:
        groups = {int(row[1]) for row in session_members(anchor) if row[1] != str(anchor)}
        for group in groups:
            pin = os.fork()
            if pin == 0:
                try:
                    os.setpgid(0, group)
                    os.killpg(group, sig)
                except ProcessLookupError: pass
                except PermissionError: pass
                finally: os._exit(0)
            os.waitpid(pin, 0)
        if sig != signal.SIGKILL or not groups: break
        time.sleep(0.01)
    os.killpg(anchor, sig)

def supervise(key, request):
    global OWNED_GUARDIAN
    if sys.platform.startswith('linux'):
        import ctypes
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Cannot establish process subreaper')
    path = location(key)
    # start() creates and locks the directory before forking, closing the
    # never-started/start-in-flight ambiguity for recovery.
    server = socket.socket(socket.AF_UNIX)
    server.bind(control_path(key)); server.listen(8); server.setblocking(False)
    terminal = bool(request.get('pty'))
    interactive = bool(request.get('interactive') or terminal)
    cols, rows = request.get('cols', 100), request.get('rows', 30)
    screen = Screen(cols, rows) if terminal else None
    status_read, status_write = os.pipe()
    life_read, life_write = os.pipe()
    if terminal:
        import pty
        reader, writer = pty.openpty()
        fcntl.ioctl(writer, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        stdin_read = stdout_write = stderr_write = writer
        stdin_write = stdout_read = reader
        stderr_read = None
    else:
        stdin_read, stdin_write = os.pipe()
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
    guardian = os.fork()
    if guardian == 0:
        server.close(); os.close(status_read)
        os.close(life_write)
        for fd in set((stdin_write, stdout_read, stderr_read)):
            if fd is not None: os.close(fd)
        os.setsid()
        if terminal: fcntl.ioctl(writer, termios.TIOCSCTTY, 0)
        # The anchor remains alive until the supervisor explicitly kills the
        # group. PID/PGID cannot be reused while this owned child is unreaped.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        def restore_signals():
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig, signal.SIG_DFL)
        # Keep the guardian single-threaded: fork-based group pinning must not
        # inherit locks from a concurrent child.wait()/Python runtime thread.
        child = None
        try:
            env = dict(os.environ); env.update(request.get('env') or {})
            if terminal: env['TERM'] = 'xterm-256color'; env['COLUMNS'] = str(cols); env['LINES'] = str(rows)
            child = subprocess.Popen(request['argv'], cwd=request['cwd'], env=env, stdin=stdin_read, stdout=stdout_write, stderr=stderr_write, close_fds=True, preexec_fn=restore_signals)
            os.write(status_write, (json.dumps({'pid': child.pid}) + '\n').encode())
        except BaseException as e:
            os.write(status_write, (json.dumps({'code': 127, 'spawnError': str(e)}) + '\n').encode())
        reported = child is None
        for fd in set((stdin_read, stdout_write, stderr_write)):
            os.close(fd)
        if reported: os.close(status_write)
        pending_signal = None
        while True:
            if not reported:
                code = child.poll()
                if code is not None:
                    os.write(status_write, (json.dumps({'code': code}) + '\n').encode())
                    os.close(status_write)
                    reported = True
            ready, _, _ = select.select([life_read], [], [], 0.05)
            if ready:
                command = os.read(life_read, 1)
                requested_signal = signal.SIGTERM if command == b'T' else signal.SIGKILL
                if pending_signal != signal.SIGKILL: pending_signal = requested_signal
            if pending_signal is not None:
                try:
                    signal_session(pending_signal)
                    pending_signal = None
                except Exception:
                    # Inspection failure is not permission to abandon a live
                    # session. Keep its identity pinned and retry cleanup.
                    time.sleep(0.05)
    OWNED_GUARDIAN = guardian
    os.close(status_write)
    os.close(life_read)
    for fd in set((stdin_read, stdout_write, stderr_write)): os.close(fd)
    readers = {stdout_read: 'stdout', status_read: 'status'}
    if stderr_read is not None: readers[stderr_read] = 'stderr'
    for fd in readers: os.set_blocking(fd, False)
    os.set_blocking(stdin_write, False)
    input_queue = bytearray(base64.b64decode(request.get('stdin', '')))
    eof_requested = not interactive
    input_closed = False
    decoders = {name: codecs.getincrementaldecoder('utf8')('replace') for name in ('stdout', 'stderr')}
    chunks, retained, cursor, start = collections.deque(), 0, 0, 0
    byte_cursor = byte_start = 0
    wire_enabled = request.get('op') == 'bridge'
    wire, wire_cursor, wire_start = collections.deque(), 0, 0
    state = {'state': 'running', 'code': None, 'timedOut': False, 'aborted': False, 'terminationConfirmed': None, 'pid': None}
    deadline = time.monotonic() + request['timeoutMs'] / 1000 if request.get('timeoutMs', 0) > 0 else None
    stopping, killed, group_confirmed, exit_seen = None, False, False, False
    status_buffer = b''
    waiters = []
    receiving, responding = {}, {}

    def respond(connection, response):
        responding[connection] = (memoryview(json.dumps(response).encode()), time.monotonic() + 2)

    def close_client(connection):
        receiving.pop(connection, None)
        responding.pop(connection, None)
        connection.close()
    forget_requested = False
    screen_error = None
    dirty = True
    finished_at = None

    def append(stream, text):
        nonlocal retained, cursor, start, dirty, input_queue, byte_cursor, byte_start, screen_error, screen
        if not text: return
        size = units(text)
        byte_size = len(text.encode())
        chunks.append({'stream': stream, 'text': text, 'start': cursor, 'end': cursor + size, 'byteStart': byte_cursor, 'byteEnd': byte_cursor + byte_size})
        cursor += size; retained += size; byte_cursor += byte_size
        while retained > LIMIT and chunks:
            old = chunks.popleft(); retained -= old['end'] - old['start']; start = old['end']; byte_start = old['byteEnd']
        if screen:
            try: input_queue.extend(screen.feed(text))
            except Exception as e:
                screen_error = 'Terminal emulator unavailable: ' + str(e)
                screen = None
        dirty = True

    def snapshot():
        return dict(state, start=start, cursor=cursor, byteStart=byte_start, byteCursor=byte_cursor, chunks=list(chunks), screen=screen.snapshot() if screen else None, screenError=screen_error, wire=list(wire), wireStart=wire_start, wireCursor=wire_cursor)

    def stop():
        nonlocal stopping
        if stopping is None and not group_confirmed:
            stopping = time.monotonic()
            # The guardian is still our child and has not been reaped.
            try: os.write(life_write, b'T')
            except BrokenPipeError: pass
            if exit_seen:
                try:
                    if not any(row[0] != str(guardian) for row in session_members(guardian)): stopping -= 0.8
                except Exception: pass

    atomic(path + '/state', snapshot())
    while True:
        now = time.monotonic()
        if deadline is not None and now >= deadline and stopping is None:
            state['timedOut'] = True; stop(); dirty = True
        if stopping is not None and not killed and now - stopping >= 0.8:
            try: os.write(life_write, b'K')
            except BrokenPipeError: pass
            killed = True
        if killed and not group_confirmed:
            try: group_confirmed = not session_members(guardian)
            except Exception: group_confirmed = False
            if group_confirmed:
                os.waitpid(guardian, 0)
                OWNED_GUARDIAN = None
                while True:
                    try:
                        if os.waitpid(-1, os.WNOHANG)[0] == 0: break
                    except ChildProcessError: break
                state['terminationConfirmed'] = True
                if state['code'] is None: state['code'] = -signal.SIGKILL
                dirty = True
                finished_at = now
        writable = [stdin_write] if input_queue and not input_closed else []
        selected = [fd for fd, stream in readers.items() if stream == 'status' or not wire_enabled or wire_cursor - wire_start < LIMIT]
        ready, writes, _ = select.select([server] + selected + list(receiving), writable + list(responding), [], 0.05)
        for connection in list(responding):
            data, end = responding[connection]
            if now >= end:
                close_client(connection)
            elif connection in writes:
                try:
                    count = connection.send(data[:65536])
                    if count == len(data): close_client(connection)
                    else: responding[connection] = (data[count:], end)
                except BlockingIOError: pass
                except OSError: close_client(connection)
        for connection, (_, end) in list(receiving.items()):
            if now >= end: close_client(connection)
        if stdin_write in writes:
            try:
                count = os.write(stdin_write, input_queue[:65536]); del input_queue[:count]
            except OSError as e:
                if e.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                    input_closed = True
                    if not terminal: os.close(stdin_write)
        if eof_requested and not input_queue and not input_closed:
            os.close(stdin_write)
            input_closed = True
        for fd in ready:
            if fd is server:
                connection, _ = server.accept()
                connection.setblocking(False)
                receiving[connection] = (b'', now + 2)
                continue
            if isinstance(fd, socket.socket):
                connection = fd
                if connection not in receiving: continue
                try:
                    payload, end = receiving[connection]
                    part = connection.recv(65536)
                    if not part:
                        close_client(connection)
                        continue
                    payload += part
                    if len(payload) > 1048576: raise ValueError('Control request exceeds 1 MiB')
                    receiving[connection] = (payload, end)
                    if b'\n' not in payload: continue
                    receiving.pop(connection)
                    req = json.loads(payload)
                    if req.get('key') != key: raise ValueError('Wrong supervisor identity')
                    op = req['op']
                    if 'wireCursor' in req:
                        acknowledged = req['wireCursor']
                        if not wire_start <= acknowledged <= wire_cursor: raise ValueError('Invalid protocol acknowledgement')
                        while wire and wire[0]['end'] <= acknowledged:
                            wire_start = wire.popleft()['end']
                    if op == 'wait' and state['state'] == 'running' and cursor <= req.get('cursor', 0):
                        waiters.append((connection, req, now + min(30, max(0, req.get('waitMs', 30000) / 1000))))
                        connection = None
                        continue
                    if op == 'stop': stop()
                    elif op == 'forget':
                        if state['state'] == 'running' or not group_confirmed: raise ValueError('Cannot forget live ownership')
                        if wire_enabled and wire_cursor > req.get('wireCursor', 0): raise ValueError('Protocol output is not acknowledged')
                        forget_requested = True
                    elif op == 'deadline':
                        deadline = None if not req.get('timeoutMs') else time.monotonic() + req['timeoutMs'] / 1000
                    elif op == 'send':
                        if state['state'] != 'running': raise ValueError('Command has exited')
                        if req.get('cols') is not None:
                            if not terminal: raise ValueError('Resize requires a PTY')
                            if group_confirmed or input_closed: raise ValueError('Terminal session has exited')
                            if screen is None: raise ValueError(screen_error or 'Terminal emulator unavailable')
                            cols, rows = req['cols'], req['rows']
                            if not 2 <= cols <= 500 or not 2 <= rows <= 300: raise ValueError('Invalid terminal size')
                            fcntl.ioctl(stdin_write, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0)); screen.resize(cols, rows)
                        data = base64.b64decode(req.get('data', ''))
                        if data:
                            if input_closed: raise ValueError('Command stdin is closed')
                            if len(input_queue) + len(data) > LIMIT: raise ValueError('Command stdin queue is full')
                            input_queue.extend(data)
                        if req.get('eof'):
                            if terminal:
                                if input_closed: raise ValueError('Command stdin is closed')
                                input_queue.extend(b'\x04')
                            else: eof_requested = True
                    elif op == 'tcp':
                        try:
                            with socket.create_connection((req.get('host', '127.0.0.1'), req['port']), timeout=0.2): pass
                            respond(connection, {'ready': True}); continue
                        except OSError:
                            respond(connection, {'ready': False}); continue
                    elif op not in ('status', 'wait', 'screen'): raise ValueError('Unknown supervisor operation')
                    response = snapshot()
                    requested = req.get('cursor', 0)
                    response['chunks'] = [chunk for chunk in response['chunks'] if chunk['end'] > requested]
                    response['wire'] = [chunk for chunk in response['wire'] if chunk['end'] > req.get('wireCursor', 0)]
                    respond(connection, response)
                    if op in ('stop', 'send', 'deadline'): dirty = True
                except Exception as e:
                    try: respond(connection, {'error': str(e)})
                    except OSError: pass
                finally:
                    if connection is not None and connection not in receiving and connection not in responding: connection.close()
                continue
            stream = readers[fd]
            size = 65536 if stream == 'status' or not wire_enabled else min(65536, LIMIT - (wire_cursor - wire_start))
            if size <= 0: continue
            try: data = os.read(fd, size)
            except OSError as e:
                if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK): continue
                data = b''
            stream = readers[fd]
            if not data:
                del readers[fd]; os.close(fd)
                if fd == stdin_write: input_closed = True
                if stream != 'status': append(stream, decoders[stream].decode(b'', final=True))
                continue
            if stream == 'status':
                status_buffer += data
                while b'\n' in status_buffer:
                    line, status_buffer = status_buffer.split(b'\n', 1)
                    update = json.loads(line); state.update(update)
                    if 'code' in update: exit_seen = True; stop()
                    dirty = True
            else:
                if wire_enabled:
                    wire.append({'stream': stream, 'start': wire_cursor, 'end': wire_cursor + len(data), 'data': base64.b64encode(data).decode()})
                    wire_cursor += len(data)
                append(stream, decoders[stream].decode(data))
        if group_confirmed and not readers and state['state'] == 'running':
            state['state'] = 'exited'; dirty = True
        for waiting in list(waiters):
            connection, req, end = waiting
            if state['state'] == 'running' and cursor <= req.get('cursor', 0) and now < end: continue
            try:
                response = snapshot()
                response['chunks'] = [chunk for chunk in response['chunks'] if chunk['end'] > req.get('cursor', 0)]
                respond(connection, response)
            except OSError: connection.close()
            finally: waiters.remove(waiting)
        # Live recovery reads the authenticated socket. Only the final bounded
        # output is fsynced, not the entire rolling buffer twice every second.
        if dirty and state['state'] != 'running':
            atomic(path + '/state', snapshot()); dirty = False
        if not responding and (forget_requested or (finished_at is not None and not readers and now - finished_at > 2)): break
    if not forget_requested: atomic(path + '/state', snapshot())
    server.close(); os.unlink(control_path(key))
    if forget_requested: shutil.rmtree(path)

def start(key, request):
    path = location(key)
    try: os.mkdir(path, 0o700)
    except FileExistsError: return rpc(key, {'op': 'status'})
    lease = open(path + '/owner', 'a')
    fcntl.flock(lease, fcntl.LOCK_EX)
    pid = os.fork()
    if pid == 0:
        os.setsid()
        if os.fork(): os._exit(0)
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2): os.dup2(null, fd)
        if null > 2: os.close(null)
        try: supervise(key, request)
        except BaseException as e:
            # Process exit closes the lifetime pipe. The in-session guardian
            # pins and kills all its job-control groups before killing itself.
            try: atomic(path + '/state', {'state': 'running', 'error': 'Supervisor failed: ' + str(e), 'terminationConfirmed': False})
            except Exception: pass
        os._exit(0)
    os.waitpid(pid, 0)
    lease.close()
    end = time.monotonic() + 10
    while time.monotonic() < end:
        try: return rpc(key, {'op': 'status'})
        except SupervisorFailure as e:
            if e.code != 'retry': raise
            time.sleep(0.02)
    raise SupervisorFailure('Supervisor did not acknowledge startup', 'retry')

def bridge(key, request):
    request['interactive'] = True
    response = start(key, request)
    cursor, eof = 0, False
    cancelled = False
    def interrupt(*args):
        nonlocal cancelled
        cancelled = True
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT): signal.signal(sig, interrupt)
    while True:
        if response['wireStart'] > cursor: raise RuntimeError('Invalid protocol acknowledgement state')
        for chunk in response['wire']:
            if chunk['end'] <= cursor: continue
            data = base64.b64decode(chunk['data'])[max(0, cursor - chunk['start']):]
            fd = 1 if chunk['stream'] == 'stdout' else 2
            while data:
                count = os.write(fd, data); data = data[count:]
            cursor = chunk['end']
        if response['state'] != 'running':
            code = response.get('code') or 0
            # Final wire bytes were written before acknowledgement. The host
            # retains control until it separately observes this final snapshot.
            rpc(key, {'op': 'status', 'wireCursor': cursor})
            return 128 - code if code < 0 else code
        if cancelled:
            rpc(key, {'op': 'stop'}); cancelled = False
        if not eof:
            ready, _, _ = select.select([0], [], [], 0.025)
            if ready:
                data = os.read(0, 65536)
                if data: rpc(key, {'op': 'send', 'data': base64.b64encode(data).decode()})
                else:
                    eof = True
                    rpc(key, {'op': 'send', 'eof': True})
                    if request.get('stopOnEof', True): rpc(key, {'op': 'stop'})
        else: time.sleep(0.025)
        response = rpc(key, {'op': 'status', 'wireCursor': cursor, 'cursor': response['cursor']})

def main():
    request = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
    key = request['key']
    if request['op'] == 'bridge':
        try: code = bridge(key, request)
        except BaseException:
            try: rpc(key, {'op': 'stop'})
            except Exception: pass
            raise
        sys.exit(code)
    elif request['op'] == 'start': print(json.dumps(start(key, request)))
    else: print(json.dumps(rpc(key, request)))

try: main()
except Exception as e:
    print(json.dumps({'error': str(e), 'errorCode': getattr(e, 'code', 'request')})); sys.exit(1)
`;

export const PROCESS_SUPERVISOR_FILENAME = `process-${sha256Hex(PROCESS_SUPERVISOR_SOURCE).slice(0, 20)}.py`;
