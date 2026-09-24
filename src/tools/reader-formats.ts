import { extname } from "node:path";
import type { Arguments, ToolContext } from "../contracts.ts";
import { argOptionalString, ToolFailure } from "./util.ts";
import type { Workspace } from "./workspace.ts";

const ADAPTER = String.raw`
import sys,json,os,zipfile,tarfile,gzip,bz2,lzma,sqlite3,urllib.parse,xml.etree.ElementTree as ET
p,member,table,query=sys.argv[1:]
CAP=16*1024*1024
class BoundedWriter:
 def __init__(self,target): self.target,self.bytes=target,0
 def write(self,text):
  self.bytes+=len(text.encode('utf-8'))
  if self.bytes>CAP: raise ValueError('Reader result exceeds 16 MiB; narrow the member/query')
  return self.target.write(text)
 def flush(self): self.target.flush()
sys.stdout=BoundedWriter(sys.stdout)

def load(f):
 b=f.read(CAP+1)
 if len(b)>CAP: raise ValueError('Decoded content exceeds 16 MiB safety limit; select a smaller archive member or a narrower SQLite query')
 return b

def emit(b):
 if isinstance(b,bytes):
  if b'\0' in b: raise ValueError('Selected member is binary, not text')
  b=b.decode('utf-8-sig')
 if len(b.encode('utf-8'))>CAP: raise ValueError('Result exceeds 16 MiB safety limit')
 sys.stdout.write(b)

def zip_read(z,name):
 info=z.getinfo(name)
 if info.file_size>CAP: raise ValueError('Archive member exceeds 16 MiB safety limit')
 with z.open(info) as f: return load(f)

lower=p.lower()
if lower.endswith(('.sqlite','.sqlite3','.db','.db3')):
 db=sqlite3.connect('file:'+urllib.parse.quote(os.path.abspath(p))+'?mode=ro',uri=True)
 try:
  # SQLite enforces this before materializing oversized SQL values, unlike a
  # Python len() check after fetch. Fail closed on older host Python builds.
  if not callable(getattr(db,'setlimit',None)) or not callable(getattr(db,'getlimit',None)):
   raise RuntimeError('Bounded SQLite reading requires Python 3.11+ with sqlite3.Connection.setlimit/getlimit on the active host')
  length_limit=getattr(sqlite3,'SQLITE_LIMIT_LENGTH',0)
  cell_cap=1024*1024
  db.setlimit(length_limit,cell_cap)
  if not 0<db.getlimit(length_limit)<=cell_cap:
   raise RuntimeError('Active-host SQLite cannot enforce the required 1 MiB value/row allocation limit')
  db.execute('PRAGMA query_only=ON')
  allowed={getattr(sqlite3,'SQLITE_SELECT',21),getattr(sqlite3,'SQLITE_READ',20),getattr(sqlite3,'SQLITE_FUNCTION',31),getattr(sqlite3,'SQLITE_RECURSIVE',33)}
  db.set_authorizer(lambda action,a,b,c,d: getattr(sqlite3,'SQLITE_OK',0) if action in allowed else getattr(sqlite3,'SQLITE_DENY',1))
  ticks=[0]
  def progress():
   ticks[0]+=1
   return int(ticks[0]>10000)
  db.set_progress_handler(progress,1000)
  if query: sql=query
  elif table: sql='SELECT * FROM "'+table.replace('"','""')+'"'
  else: sql="SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
  def emit_sql_row(row):
   # Bound the worst-case encoded size before hex(), dumps() or UTF-8 copies.
   estimate=3
   for value in row:
    if isinstance(value,(bytes,str)):
     if len(value)>cell_cap: raise ValueError('SQLite cell exceeds 1 MiB; select substr(column,1,N) or length(column)')
     estimate+=len(value)*(2 if isinstance(value,bytes) else 6)+16
    else: estimate+=32
   if estimate>CAP-sys.stdout.bytes:
    raise ValueError('SQLite output exceeds 16 MiB; narrow rows with LIMIT/WHERE or cells with substr()/length()')
   sys.stdout.write(json.dumps(row,ensure_ascii=False,default=lambda v:{'hex':v.hex()})+'\n')
  cur=db.execute(sql)
  # Positional rows preserve every value even when SQL column names repeat.
  emit_sql_row([d[0] for d in cur.description])
  for row in cur: emit_sql_row(row)
 except sqlite3.DataError as error:
  raise ValueError('SQLite value/row exceeds the 1 MiB allocation limit; select substr(column,1,N) or length(column) instead of the full cell') from error
 finally: db.close()
elif lower.endswith('.docx'):
 with zipfile.ZipFile(p) as z:
  root=ET.fromstring(zip_read(z,'word/document.xml'))
  emit('\n'.join(''.join(n.itertext()) for n in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p')))
elif zipfile.is_zipfile(p):
 with zipfile.ZipFile(p) as z:
  if member: emit(zip_read(z,member))
  else:
   for n,info in enumerate(z.infolist()):
    if n>=100000: raise ValueError('Archive exceeds 100000 member safety limit')
    sys.stdout.write(json.dumps({'member':info.filename,'bytes':info.file_size})+'\n')
elif tarfile.is_tarfile(p):
 with tarfile.open(p,'r:*') as t:
  if member:
   info=t.getmember(member)
   if not info.isfile(): raise ValueError('Selected archive member is not a regular file')
   if info.size>CAP: raise ValueError('Archive member exceeds 16 MiB safety limit')
   with t.extractfile(info) as f: emit(load(f))
  else:
   for n,info in enumerate(t):
    if n>=100000: raise ValueError('Archive exceeds 100000 member safety limit')
    sys.stdout.write(json.dumps({'member':info.name,'bytes':info.size,'file':info.isfile()})+'\n')
elif lower.endswith(('.gz','.bz2','.xz','.lzma')):
 opener=gzip.open if lower.endswith('.gz') else bz2.open if lower.endswith('.bz2') else lzma.open
 with opener(p,'rb') as f: emit(load(f))
else: raise ValueError('Unsupported archive or document format')
`;

export function isStructuredFile(path: string): boolean {
	return /\.(zip|jar|whl|apk|tar|tgz|gz|bz2|xz|lzma|sqlite|sqlite3|db|db3|pdf|docx)$/i.test(path);
}

export async function readStructuredFile(
	workspace: Workspace,
	path: string,
	args: Arguments,
	context: ToolContext,
): Promise<string> {
	const stat = await workspace.fs.stat(path, { hash: false, signal: context.signal });
	if (!/\.(sqlite|sqlite3|db|db3)$/i.test(path) && stat.size > 128 * 1024 * 1024)
		throw new ToolFailure("Archive/document exceeds the 128 MiB encoded-input safety limit.");
	if (args.table !== undefined && args.query !== undefined)
		throw new ToolFailure("Choose table or query, not both.");
	let argv: string[];
	if (extname(path).toLowerCase() === ".pdf") {
		const binary = await workspace.requireBinary(
			"pdftotext",
			"PDF extraction (install Poppler)",
			context.signal,
		);
		argv = [binary, "-layout", path, "-"];
	} else {
		const python = await workspace.requireBinary(
			"python3",
			"archive, SQLite and document reading",
			context.signal,
		);
		argv = [
			python,
			"-c",
			ADAPTER,
			path,
			argOptionalString(args, "member") ?? "",
			argOptionalString(args, "table") ?? "",
			argOptionalString(args, "query") ?? "",
		];
	}
	const result = await workspace.executor.exec(argv, {
		cwd: workspace.base(context.cwd),
		signal: context.signal,
		timeoutMs: 60_000,
		maxCaptureBytes: 16 * 1024 * 1024,
	});
	if (result.code !== 0 || result.timedOut || result.aborted || result.droppedStdoutBytes) {
		throw new ToolFailure(
			`Cannot read ${path}: ${result.stderr.trim() || (result.droppedStdoutBytes ? "decoded output exceeds 16 MiB; narrow the member/query" : `reader exited ${result.code}`)}`,
		);
	}
	return result.stdout;
}
