'use strict';
// Read/write boundary: only real, non-symlink files within the selected trusted workspace.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {TextDecoder}=require('node:util');
const EXCLUDED_DIRS=new Set(['.git','.hg','.svn','node_modules','venv','.venv','__pycache__','.next','dist','build','coverage','.tox','.mypy_cache','.pytest_cache','.idea','.terraform','.aws','.docker','.azure','.kube','.gnupg']);
const SECRET_NAMES=[/^\.env($|\.)/i,/^id_(rsa|ed25519|ecdsa)/i,/\.(pem|p12|pfx|key|kdbx)$/i,/^credentials(\.|$)/i,/^secrets?(\.|$)/i,/^\.npmrc$/i,/^\.pypirc$/i,/^\.netrc$/i,/^\.ssh$/i];
const MAX_FILE=150_000, MAX_REQUIREMENTS_FILE_BYTES=1024*1024, MAX_SEARCH=300, MAX_LIST=350,MAX_READ=95_000,MAX_FULL_REWRITE=12_000;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
/** Minimal defense-in-depth: redact obvious credential values in AI context,
 * not the files on disk. This is deliberately not an enterprise DLP engine. */
const {redactText:redactContext}=require('./redaction');

function protectedPart(component){
  const part=String(component).toLowerCase();
  // DOS 8.3 aliases (e.g. GIT~1) can resolve to protected folders on NTFS.
  return EXCLUDED_DIRS.has(part)||SECRET_NAMES.some(r=>r.test(component))||/~[1-9][0-9]*(?:\.|$)/i.test(component);
}
function windowsSame(a,b){return path.win32.normalize(String(a)).toLowerCase()===path.win32.normalize(String(b)).toLowerCase();}
function relativeSafe(root,candidate){
  if(typeof candidate!=='string'||!candidate||candidate.includes('\0'))throw Error('Invalid file path');
  const candidateFull=path.resolve(root,candidate);const rel=path.relative(path.resolve(root),candidateFull);
  if(!rel || rel==='.' )throw Error('Choose a file inside the workspace');
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('File is outside the selected workspace');
  if(rel.split(path.sep).some(p=>protectedPart(p)||p.includes(':')||/[. ]$/.test(p)))throw Error('Protected, alternate-stream or invalid path');
  const full=path.resolve(root,rel); // Normalize drive-letter casing to the chosen workspace root on Windows.
  return {full,relative:rel.split(path.sep).join('/')};
}
function assertNoLinks(root,full,allowMissing){
  const base=path.resolve(root); let now=base;
  const parts=path.relative(base,full).split(path.sep);
  for(const part of parts){now=path.join(now,part);let st;
    try{st=fs.lstatSync(now)}catch(e){if(allowMissing&&e.code==='ENOENT')continue;throw e;}
    if(st.isSymbolicLink())throw Error('Symbolic link or junction is not allowed');
  }
  const canonicalBase=fs.realpathSync.native(base);
  const realParent=fs.realpathSync.native(fs.existsSync(path.dirname(full))?path.dirname(full):base);
  const rel=path.relative(canonicalBase,realParent);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Path resolves outside workspace');
}
function checkFile(root,p,mode='read'){
  if(!['read','write','requirements'].includes(mode))throw Error('Unsupported file-access mode');
  const f=relativeSafe(root,p);
  if(mode==='requirements'&&!fs.existsSync(f.full))throw Error('File does not exist');
  assertNoLinks(root,f.full,mode==='write');
  if(fs.existsSync(f.full)){
    const st=fs.statSync(f.full);if(!st.isFile())throw Error('Only regular files are supported');
    // A hard link can point to the same inode as a file outside this workspace.
    // realpath() cannot detect it because both names are canonical paths. Refuse
    // multi-linked files before any read, index, staged edit or Apply check.
    if(st.nlink>1)throw Error('Hard-linked files with multiple links are not allowed in AI workspace operations');
    // Requirements are never exposed to the AI file-reading path. This named
    // access mode keeps all existing containment, link, and protected-name checks.
    if(st.size>(mode==='requirements'?MAX_REQUIREMENTS_FILE_BYTES:MAX_FILE))
      throw Error(mode==='requirements'?'Requirements file exceeds 1 MiB limit':'File exceeds 150 KB limit');
  }else if(mode==='read')throw Error('File does not exist');
  return f;
}
function decodeUtf8(bytes){
  if(bytes.includes(0))throw Error('Binary or non-UTF-8 file not supported for editing');
  const text=bytes.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(bytes))throw Error('Invalid UTF-8 encoding. Refusing to modify the file');
  // VS Code's text document model handles the existing BOM on save. Never insert
  // U+FEFF into a WorkspaceEdit replacement or it can be written twice.
  return text.startsWith('\uFEFF')?text.slice(1):text;
}
function decodeForRead(bytes){
  if(bytes.length>=2 && bytes[0]===0xFF && bytes[1]===0xFE){
    if((bytes.length-2)%2)throw Error('Invalid UTF-16LE encoding');
    const text=bytes.subarray(2).toString('utf16le');
    return {text,encoding:'UTF-16LE BOM',readOnly:true,warning:'UTF-16 file is read-only in Whale Bone. Convert to UTF-8 before editing.'};
  }
  if(bytes.length>=2 && bytes[0]===0xFE && bytes[1]===0xFF){
    if((bytes.length-2)%2)throw Error('Invalid UTF-16BE encoding');
    const swapped=Buffer.from(bytes.subarray(2));
    for(let i=0;i<swapped.length;i+=2){const v=swapped[i];swapped[i]=swapped[i+1];swapped[i+1]=v;}
    return {text:swapped.toString('utf16le'),encoding:'UTF-16BE BOM',readOnly:true,warning:'UTF-16 file is read-only in Whale Bone. Convert to UTF-8 before editing.'};
  }
  try{return {text:decodeUtf8(bytes),encoding:bytes.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf]))?'UTF-8 BOM':'UTF-8',readOnly:false};}
  catch(e){
    if(bytes.includes(0)||e.message==='Binary file not supported')throw e;
    // The bytes do not declare a legacy code page. Windows-1256 is only a
    // conservative read-only display fallback for Arabic enterprise sources.
    // Never permit editing a legacy-decoded file or claim the encoding is known.
    const text=new TextDecoder('windows-1256',{fatal:true}).decode(bytes);
    if(/[\x00-\x08\x0e-\x1f]/.test(text))throw Error('Binary/control characters; not a readable text file');
    return {text,encoding:'Windows-1256 (assumed)',readOnly:true,warning:'Legacy encoding guessed as Windows-1256; verify text before relying on it. Editing requires verified UTF-8.'};
  }
}
function read(root,p){const f=checkFile(root,p);const contents=fs.readFileSync(f.full);const decoded=decodeForRead(contents);const text=decoded.text;
  let part=text.slice(0,MAX_READ);if(/[\uD800-\uDBFF]$/.test(part))part=part.slice(0,-1);
  return {path:f.relative,text:redactContext(part),hash:hash(contents),truncated:part.length<text.length,encoding:decoded.encoding,readOnly:decoded.readOnly,warning:decoded.warning};}
function readLines(root,p,startLine=1,endLine=startLine+100){
  if(!Number.isSafeInteger(startLine)||!Number.isSafeInteger(endLine)||startLine<1||endLine<startLine||endLine-startLine>250)throw Error('Invalid line range');
  const f=checkFile(root,p);const decoded=decodeForRead(fs.readFileSync(f.full));const text=decoded.text;const lines=redactContext(text).split(/\r?\n/);
  return {path:f.relative,startLine,endLine:Math.min(endLine,lines.length),totalLines:lines.length,
    text:lines.slice(startLine-1,endLine).map((v,i)=>`${startLine+i}: ${v}`).join('\n').slice(0,26000),encoding:decoded.encoding,readOnly:decoded.readOnly,warning:decoded.warning};
}
/** Bounded, deterministic traversal; caller sees truncation instead of false completeness. */
function walk(root,dir='.',maxFiles=MAX_LIST,maxEntries=2500){
 const start=dir==='.'?{full:path.resolve(root),relative:''}:relativeSafe(root,dir);
 if(dir!=='.')assertNoLinks(root,start.full,false);
 if(!fs.statSync(start.full).isDirectory())throw Error('Not a folder');
 const files=[],stack=[start.full];let scanned=0,truncated=false,limitReached=false,unreadableDirectories=0;
 while(stack.length){
  const here=stack.pop();let entries=[];
  try{entries=fs.readdirSync(here,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));}catch{truncated=true;unreadableDirectories++;continue;}
  for(let i=0;i<entries.length;i++){
   scanned++;if(scanned>maxEntries||files.length>=maxFiles){truncated=true;limitReached=true;break;}
   const e=entries[i];if(protectedPart(e.name)||e.isSymbolicLink())continue;
   const full=path.join(here,e.name);let relative;
   try{relative=relativeSafe(root,full).relative;}catch{continue;}
   if(e.isDirectory()){if(relative.replaceAll('\\','/').toLowerCase()==='.whalebone/wheels')continue;stack.push(full);}
   else if(e.isFile())files.push(relative);
  }
  if(limitReached)break;
 }
 return {files:files.sort(),scanned,truncated:truncated||stack.length>0,unreadableDirectories};
}
function listWithCoverage(root,dir='.') {return walk(root,dir,MAX_LIST,2500);}
function listPage(root,dir='.',cursor=0,pageSize=120){
 if(!Number.isSafeInteger(cursor)||cursor<0||cursor>12000)throw Error('Invalid repository listing cursor');
 const info=walk(root,dir,12000,18000);
 const count=Math.min(120,Math.max(1,pageSize));
 const files=info.files.slice(cursor,cursor+count);
 const nextCursor=cursor+files.length<info.files.length?cursor+files.length:null;
 return {files,nextCursor,scanned:info.scanned,truncated:info.truncated,incomplete:info.truncated||nextCursor!==null};
}
function list(root,dir='.') {return listWithCoverage(root,dir).files;}
function searchWithCoverage(root,q,options={}){
 const term=String(q||'').trim().slice(0,120);if(term.length<2)throw Error('Search needs at least two characters');
 const {files,scanned,truncated:scanTruncated,unreadableDirectories}=walk(root,'.',12000,18000);
 const matches=[];let truncated=scanTruncated,skippedOversized=0,skippedUnreadable=0,skippedBinary=0,redactedMatches=0,successfullySearched=0,bytesRead=0;
 const deadline=Date.now()+Math.max(1000,Math.min(12000,Number(options.timeBudgetMs)||12000));
 const maxBytes=Math.max(MAX_FILE,Math.min(25_000_000,Number(options.maxBytes)||12_000_000));
 for(const file of files){
  if(options.signal?.aborted){truncated=true;break;}
  if(Date.now()>deadline||bytesRead>=maxBytes||matches.length>=MAX_SEARCH){truncated=true;break;}
  try{
   const f=checkFile(root,file);const bytes=fs.readFileSync(f.full);bytesRead+=bytes.length;
   if(bytesRead>maxBytes){truncated=true;break;}
   const decoded=decodeForRead(bytes),lines=decoded.text.split(/\r?\n/),safeLines=redactContext(decoded.text).split(/\r?\n/);successfullySearched++;
   if(file.toLowerCase().includes(term.toLowerCase())){matches.push({file,line:0,preview:'Filename match'});continue;}
   for(let n=0;n<lines.length;n++)if((safeLines[n]??'').toLowerCase().includes(term.toLowerCase())){
    if(matches.length>=MAX_SEARCH){truncated=true;break;}
    const raw=lines[n].trim().slice(0,180),preview=safeLines[n].trim().slice(0,180);if(preview!==raw)redactedMatches++;
    matches.push({file,line:n+1,preview});
   }
  }catch(e){
   if(/150 KB limit/i.test(String(e.message)))skippedOversized++;
   else if(/binary|encoding|UTF-8|control characters/i.test(String(e.message)))skippedBinary++;
   else skippedUnreadable++;
  }
 }
 const skipped=skippedOversized+skippedUnreadable+skippedBinary+unreadableDirectories;
 const incomplete=truncated||skipped>0;
 return {matches,scanned,filesExamined:files.length,successfullySearched,succeeded:successfullySearched,skipped,skippedOversized,skippedUnreadable,skippedBinary,unreadableDirectories,redactedMatches,bytesRead,truncated:incomplete,incomplete};
}
function search(root,q){return searchWithCoverage(root,q).matches;}
function fingerprint(key,edit){
  // Identity of an operation, not its occurrence in a model reply. A resent
  // batch cannot apply a previously staged insertion or replacement twice.
  const isPatch=typeof edit.find==='string'&&typeof edit.replace==='string';
  return hash(Buffer.from(JSON.stringify([key,isPatch?'patch':'content',isPatch?edit.find:edit.content,isPatch?edit.replace:null])));
}
function prepareEdit(root,edit,previous=null){
  if(!edit||typeof edit!=='object'||typeof edit.path!=='string')throw Error('Edit must include a file path');
  const targeted=typeof edit.find==='string'&&typeof edit.replace==='string';
  if(!targeted&&typeof edit.content!=='string')throw Error('Edit requires content or a find/replace patch');
  const f=checkFile(root,edit.path,'write');const existing=fs.existsSync(f.full)?fs.readFileSync(f.full):null;
  const onDisk=existing?decodeUtf8(existing):'';
  if(previous && (previous.path.toLowerCase()!==f.relative.toLowerCase() || !windowsSame(previous.full,f.full)))throw Error('Cannot combine edits to different paths');
  const originalHash=existing?hash(existing):null;
  if(previous && previous.originalHash!==originalHash)throw Error('File changed while preparing a grouped proposal');
  const operation=fingerprint(f.relative.toLowerCase(),edit);
  if(previous?.appliedOps?.includes(operation))return previous;
  const before=previous?previous.after:onDisk;
  let after;
  if(targeted){
    if(!existing)throw Error('Targeted patch requires an existing file');
    if(!edit.find||Buffer.byteLength(edit.find,'utf8')>24_000)throw Error('Patch anchor must be 1–24 KB');
    const lineEnd=before.includes('\r\n')?'\r\n':'\n';
    const candidate=before.includes(edit.find)?edit.find:edit.find.replace(/\r?\n/g,lineEnd);
    const first=before.indexOf(candidate);
    // Search from first+1 to detect overlapping matches, not first+length.
    if(first<0||before.indexOf(candidate,first+1)!==-1)throw Error('Patch anchor must occur exactly once (unique exact match)');
    const replacement=edit.replace.replace(/\r?\n/g,lineEnd);
    after=before.slice(0,first)+replacement+before.slice(first+candidate.length);
  }else{
    if(existing&&existing.length>MAX_FULL_REWRITE)throw Error('Large files require a targeted find/replace patch, not full replacement');
    if(existing&&/[^\x00-\x7f]/.test(before)&&before!==edit.content)throw Error('Existing Unicode files require a targeted patch to preserve unaffected text');
    after=edit.content;
  }
  const markers=text=>(String(text).match(/\[REDACTED\]/g)||[]).length;
  if(markers(after)>markers(before))throw Error('Proposed edit adds a redaction placeholder; request a targeted edit of unredacted source instead');
  if(after.startsWith('\uFEFF'))throw Error('Proposed content must not contain a leading UTF-8 BOM; VS Code manages file encoding');
  if(Buffer.byteLength(after,'utf8')>MAX_FILE)throw Error('Proposed file exceeds 150 KB');
  if(after.includes('\uFFFD')&&!before.includes('\uFFFD'))throw Error('Possible Unicode encoding corruption (replacement character); refusing edit');
  const mojibake=/(?:[ÃÂ][\u0080-\u00bf]|[ÙØ][\u0080-\u00bfØÙ]|â[€œ„€™])/u;
  if(mojibake.test(after)&&!mojibake.test(before))throw Error('Suspected text encoding corruption (mojibake); refusing edit');
  if(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(after))throw Error('Invalid Unicode surrogate in proposed edit');
  return {id:crypto.randomUUID(),path:f.relative,full:f.full,before:previous?previous.before:onDisk,after,originalHash,
    hadBom:existing?.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf]))||false,
    appliedOps:[...(previous?.appliedOps||[]),operation],newFile:!existing,
    summary:String(edit.summary||previous?.summary||'').slice(0,300),previewed:false};
}

/** Stage each requested operation independently. Security failures are rejected
 * for the offending path; they cannot cancel already validated proposals.
 * On retries every successful operation is idempotent, including insertions.
 */
function prepareBatch(root,specs,previous=[]){
  if(!Array.isArray(specs)||!specs.length||specs.length>16)throw Error('Expected 1–16 edit operations');
  const staged=new Map(previous instanceof Map?previous:new Map(previous.map(x=>[x.path.toLowerCase(),x])));
  const failures=[];
  for(const [index,spec] of specs.entries()){
    const label=String(spec?.path??'(missing path)').slice(0,300);
    try{
      if(!spec||typeof spec.path!=='string')throw Error('Missing edit path');
      const file=checkFile(root,spec.path,'write');
      const key=file.relative.toLowerCase();
      const prior=staged.get(key)||null;
      const candidate=prepareEdit(root,spec,prior);
      staged.set(key,candidate);
    }catch(error){
      const message=String(error?.message||error).slice(0,500);
      const retryable=/anchor|match|Unicode|replacement|content/i.test(message) && !/Protected|outside|file exceeds|regular files/i.test(message);
      failures.push({path:label,operation:index+1,error:message,retryable});
    }
  }
  return {edits:[...staged.values()],failures};
}

function ensureEditParent(root,edit){
  stillValid(root,edit);
  fs.mkdirSync(path.dirname(edit.full),{recursive:true});
  stillValid(root,edit); // Check again because a parent might have changed since approval.
  return path.dirname(edit.full);
}
function skillDestination(root,label){
  if(!/^[a-z][a-z0-9-]{2,40}$/.test(label))throw Error('Invalid skill name');
  const file=path.join('.whalebone','skills',label,'SKILL.md');
  return checkFile(root,file,'write').full;
}
function stillValid(root,edit){
  const f=checkFile(root,edit.path,'write');if(f.full!==edit.full)throw Error('Path changed during review');
  const exists=fs.existsSync(f.full);
  if(edit.newFile&&exists)throw Error('File appeared since preview');
  if(!edit.newFile&&!exists)throw Error('File disappeared since preview');
  if(exists&&hash(fs.readFileSync(f.full))!==edit.originalHash)throw Error('File changed since preview, regenerate the diff');
  return true;
}
module.exports={redactContext,listPage,listWithCoverage,searchWithCoverage,EXCLUDED_DIRS,SECRET_NAMES,MAX_FILE,MAX_REQUIREMENTS_FILE_BYTES,MAX_FULL_REWRITE,hash,windowsSame,relativeSafe,checkFile,read,readLines,list,search,prepareEdit,prepareBatch,decodeForRead,stillValid,ensureEditParent,skillDestination};
