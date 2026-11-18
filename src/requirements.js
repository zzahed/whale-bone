'use strict';
/** Strict, offline-safe requirements parser. Supports PEP 508 markers and local -r includes,
 * but never passes unreviewed pip directives, local URLs or arbitrary paths to pip. */
const fs=require('node:fs');
const path=require('node:path');
const Workspace=require('./workspace');
const PROJECT=/^[a-z0-9][a-z0-9._-]{0,150}$/i;
const REQ=/^([a-z0-9][a-z0-9._-]{0,150})(?:\[\s*([a-z0-9._-]+(?:\s*,\s*[a-z0-9._-]+)*)\s*\])?\s*((?:(?:===|==|~=|!=|<=|>=|<|>)\s*[a-z0-9.*+_!-]+(?:\s*,\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[a-z0-9.*+_!-]+)*))?\s*$/i;
const MAX_REQUIREMENTS=5000,MAX_REQUIREMENTS_FILE_BYTES=Workspace.MAX_REQUIREMENTS_FILE_BYTES,MAX_TOTAL_REQUIREMENTS_BYTES=2*1024*1024;
const MARKER_NAMES=new Set(['python_version','python_full_version','os_name','sys_platform','platform_release','platform_system','platform_version','platform_machine','platform_python_implementation','implementation_name','implementation_version','extra']);
function checkMarker(input){
 const marker=String(input).trim();if(!marker||marker.length>500)throw Error('Invalid or excessively long environment marker');
 const tokens=[];const rex=/\s*(\(|\)|===|==|~=|!=|<=|>=|<|>|\bnot\b|\bin\b|\band\b|\bor\b|[A-Za-z_][A-Za-z_0-9]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gy;
 let i=0;while(i<marker.length){rex.lastIndex=i;const m=rex.exec(marker);if(!m)throw Error('Unsupported environment marker near '+marker.slice(i,i+22));tokens.push(m[1]);i=rex.lastIndex;if(tokens.length>100)throw Error('Environment marker too complex');}
 let p=0;const peek=()=>tokens[p]?.toLowerCase(),eat=x=>peek()===x?(p++,true):false;
 const operand=()=>{const t=tokens[p];if(!t)throw Error('Incomplete environment marker');if(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(t)){p++;return;}if(MARKER_NAMES.has(t.toLowerCase())){p++;return;}throw Error('Unsupported environment marker variable: '+t);};
 const compare=()=>{if(eat('(')){expression();if(!eat(')'))throw Error('Environment marker missing )');return;}operand();let op=peek();if(op==='not'){p++;if(!eat('in'))throw Error('Expected not in in environment marker');}else if(op==='in'||['===','==','~=','!=','<=','>=','<','>'].includes(op)){p++;}else throw Error('Environment marker missing comparison operator');operand();};
 const and=()=>{compare();while(eat('and'))compare();};
 const expression=()=>{and();while(eat('or'))and();};
 expression();if(p!==tokens.length)throw Error('Unexpected environment marker token: '+tokens[p]);return marker;
}
function validateSpec(value){
 const raw=String(value||'').trim();if(!raw||raw.length>700||/[\r\n\0#@]/.test(raw)||/^[-.]/.test(raw))throw Error('Enter a package name and optional PEP 508 version or environment marker, not a URL or pip command');
 const semi=raw.indexOf(';');const base=semi<0?raw:raw.slice(0,semi);const m=base.match(REQ);if(!m||!PROJECT.test(m[1]))throw Error('Invalid package specification: '+raw.slice(0,120));
 const name=m[1],extras=m[2]?'['+m[2].split(',').map(x=>x.trim()).join(',')+']':'';
 const constraints=(m[3]||'').replace(/\s*(===|==|~=|!=|<=|>=|<|>)\s*/g,'$1').replace(/\s*,\s*/g,',');
 const marker=semi<0?'':'; '+checkMarker(raw.slice(semi+1));
 return name+extras+constraints+marker;
}
function physicalLines(text){
 const lines=String(text).split(/\r?\n/),result=[];let partial='',start=1;
 for(let i=0;i<lines.length;i++){
  const raw=lines[i].trim();if(!partial)start=i+1;
  if(raw.endsWith('\\')){partial+=raw.slice(0,-1)+' ';continue;}
  result.push({source:partial+raw,line:start});partial='';
 }
 if(partial)throw Error('Line '+start+': incomplete line continuation');
 return result;
}
function parseLine(raw){
 const s=String(raw).replace(/\s+#.*$/,'').trim();if(!s||s.startsWith('#'))return null;
 const include=s.match(/^(?:-r\s*|--requirement(?:=|\s+))(.+)$/i);
 if(include)return {include:include[1].trim()};
 if(s.startsWith('-'))throw Error('Unsupported pip option. Only local -r includes and SHA-256 --hash are allowed');
 const segments=s.split(/\s+(?=--hash(?:=|\s))/i),spec=validateSpec(segments.shift());const hashes=[];
 for(const flag of segments){const m=flag.match(/^--hash(?:=|\s+)sha256:([0-9a-f]{64})$/i);if(!m)throw Error('Invalid --hash flag. Only full SHA-256 digests are accepted');if(hashes.length>=16)throw Error('Too many hashes on a requirement');hashes.push(m[1].toLowerCase());}
 if(hashes.length){
  const exact=spec.split(';')[0].match(/^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9._,-]+\])?(?:===|==)([a-z0-9._+!-]+)$/i);
  if(!exact||exact[1].includes('*'))throw Error('Hashed requirements must pin one exact version using == or ===, without ranges or wildcards');
 }
 return {spec,hashes};
}
function parseRequirements(text){
 const result=[];for(const item of physicalLines(text)){try{const parsed=parseLine(item.source);if(!parsed)continue;if(parsed.include)throw Error('Nested -r references require selecting the actual requirements file');if(parsed.hashes.length)throw Error('Hashed requirements must be installed through the file importer');result.push(parsed.spec);if(result.length>MAX_REQUIREMENTS)throw Error('Requirements list exceeds '+MAX_REQUIREMENTS+' packages');}catch(e){throw Error('Line '+item.line+': '+e.message);}}
 if(!result.length)throw Error('No supported package specifications in requirements file');return result;
}
function parseRequirementsFile(filename,workspace){
 const root=fs.realpathSync(workspace),visited=new Set(),entries=[],files=[];let bytes=0;
 function visit(filepath,depth){
  if(depth>5)throw Error('Requirements include depth exceeds five files');
  if(files.length>=32)throw Error('Too many requirements include files (maximum 32)');
  const absolute=path.resolve(filepath),relative=path.relative(root,absolute);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Requirements include escapes the current workspace');
  // Apply the same protected-file and no-symlink policy as agent file reads.
  // Canonical containment alone would otherwise allow a requirements symlink
  // pointing at .env or another protected file *inside* the workspace.
  Workspace.checkFile(workspace,absolute,'requirements');
  const real=fs.realpathSync(absolute),realRelative=path.relative(root,real);
  if(realRelative==='..'||realRelative.startsWith('..'+path.sep)||path.isAbsolute(realRelative))throw Error('Requirements include resolves outside the workspace');
  const stat=fs.statSync(real);if(!stat.isFile()||stat.size>MAX_REQUIREMENTS_FILE_BYTES)throw Error('Requirements file must be a regular file of at most 1 MiB');
  bytes+=stat.size;if(bytes>MAX_TOTAL_REQUIREMENTS_BYTES)throw Error('Combined requirements exceed 2 MiB');
  if(visited.has(real))throw Error('Requirements include cycle or repeated file: '+path.basename(real));visited.add(real);files.push(real);
  for(const item of physicalLines(fs.readFileSync(real,'utf8'))){
   try{
    const parsed=parseLine(item.source);if(!parsed)continue;
    if(parsed.include){
     let value=parsed.include;if(/^(["']).*\1$/.test(value))value=value.slice(1,-1);
     if(!value||/[:\0\r\n*?<>|]/.test(value)||path.isAbsolute(value)||value.startsWith('-')||value.includes('://'))throw Error('Nested requirements path must be a relative local file');
     visit(path.resolve(path.dirname(real),value),depth+1);
    }else{entries.push(parsed);if(entries.length>MAX_REQUIREMENTS)throw Error('Requirements list exceeds '+MAX_REQUIREMENTS+' packages');}
   }catch(e){throw Error(path.relative(root,real)+':'+item.line+': '+e.message);}
  }
 }
 visit(filename,0);if(!entries.length)throw Error('No supported package specifications in requirements file');
 return {packages:entries.map(e=>e.spec),text:entries.map(e=>e.spec+e.hashes.map(h=>' --hash=sha256:'+h).join('')).join('\n')+'\n',files,hasHashes:entries.some(e=>e.hashes.length>0),unhashedCount:entries.filter(e=>!e.hashes.length).length};
}
module.exports={validateSpec,parseRequirements,parseRequirementsFile,checkMarker,MAX_REQUIREMENTS,MAX_TOTAL_REQUIREMENTS_BYTES};
