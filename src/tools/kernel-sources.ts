/** Reserve a free protocol descriptor before Node starts; inherited fd 1 is raw output. */
export const JAVASCRIPT_LAUNCHER = `
import os, sys
protocol = os.dup(1)
os.set_inheritable(protocol, True)
os.dup2(2, 1)
os.environ['_SALAM_KERNEL_PROTOCOL_FD'] = str(protocol)
os.execv(sys.argv[1], sys.argv[1:])
`;

/** Child programs speak JSON only on a private descriptor, never on native stdout. */
export const JAVASCRIPT_KERNEL = String.raw`
if(typeof Promise.withResolvers !== 'function') {
  console.error('JavaScript evaluation requires Node.js 22 or newer on the workspace host.');
  process.exit(1);
}
const readline = require('node:readline');
const repl = require('node:repl');
const {PassThrough} = require('node:stream');
const {inspect} = require('node:util');
const {writeSync} = require('node:fs');
const {StringDecoder} = require('node:string_decoder');
const {AsyncLocalStorage} = require('node:async_hooks');
const protocol = Number(process.env._SALAM_KERNEL_PROTOCOL_FD);
delete process.env._SALAM_KERNEL_PROTOCOL_FD;
const sendSerialized = text => {
  const bytes = Buffer.from(text + '\n');
  for(let offset = 0; offset < bytes.length;) offset += writeSync(protocol, bytes, offset, bytes.length-offset);
};
const send = value => sendSerialized(JSON.stringify(value));
const origin = new AsyncLocalStorage();
function output(value, cell = origin.getStore()) {
  const text = String(value);
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + 8192, text.length);
    if(end < text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;
    send({type:'output', cell:cell?.id, text:text.slice(i,end)});
    i = end;
  }
}
const detachedOutput = {decoders:new Map()};
function outputWriter(stream) {
  return (value, encoding, callback) => {
    const cell = origin.getStore();
    const owner = cell ?? detachedOutput;
    let decoder = owner.decoders.get(stream);
    if(!decoder) { decoder = new StringDecoder('utf8'); owner.decoders.set(stream, decoder); }
    if(Buffer.isBuffer(value) || value instanceof Uint8Array) output(decoder.write(value), cell);
    else { output(decoder.end(), cell); output(value, cell); }
    if(typeof encoding === 'function') encoding();
    if(typeof callback === 'function') callback();
    return true;
  };
}
process.stdout.write = outputWriter('stdout');
process.stderr.write = outputWriter('stderr');
const input = new PassThrough();
const sink = new PassThrough();
sink.on('data', outputWriter('repl'));
const domain = require('node:domain').create();
const server = repl.start({input, output:sink, terminal:false, prompt:'', useGlobal:false, ignoreUndefined:true, domain});
// The REPL's own listener prints errors and erases domainThrown. Handle them here,
// before that distinction between eval failures and uncaught callbacks is lost.
domain.removeAllListeners('error');
domain.on('error', error => {
  const cell = origin.getStore();
  if(cell?.active && !error?.domainThrown) cell.evaluation.reject(error);
  else output('Background error: ' + String(error?.stack ?? error) + '\n', cell);
});
process.on('unhandledRejection', error => output('Background rejection: ' + String(error?.stack ?? error) + '\n'));
let sequence = 0;
let active;
const pending = new Map();
server.context.console = new console.Console(process.stdout, process.stderr);
server.context.display = value => output(inspect(value, {depth:8, maxArrayLength:1000}) + '\n');
server.context.tool = new Proxy({}, {get: (_, name) => {
  if(name === 'then') return undefined;
  return args => {
    const cell = origin.getStore();
    if(!cell?.active) return Promise.reject(new Error('Tools can only run during their originating eval cell.'));
    if(name === 'eval') return Promise.reject(new Error('Recursive eval invocation is forbidden.'));
    const id = ++sequence;
    let serialized;
    try { serialized = JSON.stringify({type:'tool',cell:cell.id,id,name,args:args ?? {}}); }
    catch(error) { return Promise.reject(error); }
    const {promise, resolve, reject} = Promise.withResolvers();
    pending.set(id,{resolve,reject,cell});
    cell.inflight.add(promise);
    promise.then(() => cell.inflight.delete(promise), () => cell.inflight.delete(promise));
    try { sendSerialized(serialized); }
    catch(error) { pending.delete(id); reject(error); }
    return promise;
  };
}});
readline.createInterface({input:process.stdin, crlfDelay:Infinity}).on('line', async line => {
  let message;
  try {message = JSON.parse(line);} catch {return;}
  if(message.type === 'tool_result') {
    const call = pending.get(message.id); if(!call || call.cell.id !== message.cell) return;
    pending.delete(message.id);
    if(message.error) {
      const error = new Error(message.error);
      error.details = message.details;
      call.reject(error);
    } else call.resolve(message.value);
    return;
  }
  if(message.type !== 'cell') return;
  if(active) {send({type:'done',cell:message.cell,error:'Kernel is busy.'}); return;}
  const cell = {id:message.cell, active:true, evaluation:Promise.withResolvers(), inflight:new Set(), decoders:new Map()};
  active = cell;
  await origin.run(cell, async () => {
    let failure;
    try {
      server.eval(message.code + '\n', server.context, 'salam-cell.js', (error,value) => {
        if(error) cell.evaluation.reject(error);
        else {if(value !== undefined) server.context.display(value); cell.evaluation.resolve();}
      });
      await cell.evaluation.promise;
    } catch(error) { failure = String(error?.stack ?? error); }
    finally {
      while(cell.inflight.size) await Promise.allSettled([...cell.inflight]);
      cell.active = false;
      for(const decoder of cell.decoders.values()) output(decoder.end(), cell);
      cell.decoders.clear();
      active = undefined;
      send({type:'done',cell:cell.id,error:failure});
    }
  });
});
process.stdin.on('end', () => process.exit(0));
send({type:'ready'});
`;

export const PYTHON_KERNEL = String.raw`
import ast, asyncio, contextvars, inspect, json, os, sys, threading, traceback
_wire = os.fdopen(os.dup(1), 'w', encoding='utf-8')
os.dup2(2, 1)
_lock = threading.Lock()
_origin = contextvars.ContextVar('salam_cell', default=None)
def serialize(message):
    return json.dumps(message, ensure_ascii=True, allow_nan=False) + '\n'
def send_serialized(text):
    with _lock:
        _wire.write(text)
        _wire.flush()
def send(message):
    send_serialized(serialize(message))
class Output:
    encoding = 'utf-8'
    def write(self, text):
        text = str(text)
        cell = _origin.get()
        for start in range(0, len(text), 8192):
            send({'type':'output', 'cell':cell['id'] if cell else None, 'text':text[start:start+8192]})
        return len(text)
    def flush(self): pass
    def isatty(self): return False
    def fileno(self): return 1
sys.stdout = sys.stderr = Output()
loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
queue = asyncio.Queue()
pending = {}
sequence = 0
class ToolError(RuntimeError):
    def __init__(self, message, details=None):
        super().__init__(message)
        self.details = details
class Tools:
    def __getattr__(self, name):
        def invoke(args=None, **kwargs):
            global sequence
            cell = _origin.get()
            if cell is None or not cell['active']: raise RuntimeError('Tools can only run during their originating eval cell.')
            if name == 'eval': raise RuntimeError('Recursive eval invocation is forbidden.')
            if args is not None and kwargs: raise TypeError('Use a dict or keyword arguments, not both.')
            sequence += 1
            call_id = sequence
            text = serialize({'type':'tool', 'cell':cell['id'], 'id':call_id, 'name':name, 'args':kwargs if args is None else args})
            future = loop.create_future()
            settled = loop.create_future()
            pending[call_id] = (future, settled, cell)
            cell['inflight'].add(settled)
            settled.add_done_callback(cell['inflight'].discard)
            def finished(done):
                if done.cancelled(): send({'type':'tool_cancel', 'cell':cell['id'], 'id':call_id})
                else: done.exception()
            future.add_done_callback(finished)
            try: send_serialized(text)
            except BaseException:
                pending.pop(call_id, None)
                cell['inflight'].discard(settled)
                future.cancel()
                settled.cancel()
                raise
            return future
        return invoke
namespace = {'__name__':'__main__', 'tool':Tools(), 'display':print, 'asyncio':asyncio}
def receive(message):
    if message.get('type') == 'tool_result':
        entry = pending.get(message.get('id'))
        if entry is None or entry[2]['id'] != message.get('cell'): return
        future, settled, cell = pending.pop(message['id'])
        if not future.done():
            if message.get('error'): future.set_exception(ToolError(message['error'], message.get('details')))
            else: future.set_result(message.get('value'))
        settled.set_result(None)
    else:
        queue.put_nowait(message)
def reader():
    try:
        for line in sys.stdin:
            try: message = json.loads(line)
            except ValueError: continue
            loop.call_soon_threadsafe(receive, message)
    finally:
        loop.call_soon_threadsafe(queue.put_nowait, None)
async def main():
    send({'type':'ready'})
    while True:
        message = await queue.get()
        if message is None: return
        if message.get('type') != 'cell': continue
        cell = {'id':message['cell'], 'active':True, 'inflight':set()}
        token = _origin.set(cell)
        error = None
        try:
            tree = ast.parse(message['code'], filename='<salam-cell>', mode='exec')
            expression = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                expression = ast.Expression(tree.body.pop().value)
            if tree.body:
                result = eval(compile(tree, '<salam-cell>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), namespace)
                if inspect.isawaitable(result): await result
            if expression is not None:
                result = eval(compile(expression, '<salam-cell>', 'eval', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), namespace)
                if inspect.isawaitable(result): result = await result
                if result is not None: print(repr(result))
        except BaseException:
            error = traceback.format_exc()
        finally:
            # gather() completes synchronously for already-settled futures (Python 3.14), so
            # it never yields for discard callbacks; wait only on unsettled host acknowledgements.
            while True:
                unsettled = [settled for settled in cell['inflight'] if not settled.done()]
                if not unsettled: break
                await asyncio.wait(unsettled)
            cell['inflight'].clear()
            cell['active'] = False
            _origin.reset(token)
            send({'type':'done', 'cell':cell['id'], 'error':error})
threading.Thread(target=reader, daemon=True).start()
try:
    loop.run_until_complete(main())
finally:
    loop.close()
`;
