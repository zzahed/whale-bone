'use strict';
/** Scoped, registry-only npm package operations. Independent of the API transport and the PyPI relay. */
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),cp=require('node:child_process');
const {once}=require('node:events');
const REGISTRY='https://registry.npmjs.org',MAX_META=40*1024*1024,MAX_TARBALL=200*1024*1024,MAX_CACHE=1200*1024*1024,DEFAULT_META_TTL_MS=30*60*1000;
const PACKAGE=/^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)(?:@(?:[0-9a-zA-Z][0-9a-zA-Z.+~^*_-]*))?$/i;
function parseCommand(raw){
 const tokens=String(raw||'').trim().split(/\s+/).filter(Boolean);
 if(tokens[0]!=='npm')throw Error('Enter a supported npm command starting with npm.');
 const op=tokens[1];if(!['install','i','uninstall','remove','rm','list','ls','ci'].includes(op))throw Error('Allowed: npm install, uninstall, list, or ci.');
 const action=({i:'install',remove:'uninstall',rm:'uninstall',ls:'list'})[op]||op;
 let global=false;const packages=[];
 for(const token of tokens.slice(2)){
  if(token==='-g'||token==='--global'){if(global)throw Error('Duplicate global flag');global=true;continue;}
  if(!PACKAGE.test(token))throw Error('Unsupported npm package or option: '+token+'. URLs, scripts and arbitrary flags are not allowed.');
  packages.push(token);
 }
 if(['install','uninstall'].includes(action)&&(!packages.length||packages.length>40))throw Error('Choose 1 to 40 registry packages.');
 if(['ci','list'].includes(action)&&packages.length)throw Error('This command does not accept package arguments.');
 if(action==='ci'&&global)throw Error('npm ci must be local.');
 return {action,global,packages};
}
function npmEnvironment(base=process.env){const env={...base};for(const k of Object.keys(env))if(/^npm_config_|^npm_token$|^(http|https|all|no)_proxy$|^node_(?:options|path|extra_ca_certs|tls_reject_unauthorized)$/i.test(k))delete env[k];env.NO_PROXY='127.0.0.1,localhost,::1';env.no_proxy=env.NO_PROXY;return env;}
function inDirectory(candidate,root){const relative=path.relative(root,candidate);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function validateTools(tools,root){
 if(!tools||typeof tools.node!=='string'||typeof tools.cli!=='string')throw Error('Node.js and npm CLI executables must be provided.');
 const result={};
 for(const [field,expected] of [['node',/^node(?:\.exe)?$/i],['cli',/^npm-cli\.js$/i]]){
  const input=tools[field];if(!path.isAbsolute(input))throw Error('Use an absolute Node.js/npm CLI path.');
  const resolved=fs.realpathSync(input);const stat=fs.statSync(resolved);
  if(!stat.isFile()||!expected.test(path.basename(resolved)))throw Error(field==='cli'?'Choose npm-cli.js, not npm.cmd or another shell wrapper.':'Choose a Node.js executable (node or node.exe).');
  if(root&&inDirectory(resolved,fs.realpathSync(root)))throw Error('Node.js and npm CLI cannot be loaded from the AI workspace.');
  result[field]=resolved;
 }
 return result;
}
function findNpmCli({env=process.env,root}={}){
 const dirs=String(env.PATH||'').split(path.delimiter).filter(x=>path.isAbsolute(x));
 const nodeNames=process.platform==='win32'?['node.exe']:['node'];
 const maybe=[];
 for(const dir of dirs)for(const name of nodeNames){const f=path.join(dir,name);if(fs.existsSync(f))maybe.push(f);}
 if(process.platform==='win32')maybe.push(path.join(env.ProgramFiles||'C:\\Program Files','nodejs','node.exe'));
 for(const node of maybe){if(!fs.existsSync(node))continue;
  const npmCandidates=[path.join(path.dirname(node),'node_modules','npm','bin','npm-cli.js'),path.resolve(path.dirname(node),'..','lib','node_modules','npm','bin','npm-cli.js')];
  // On Unix, npm often is a symlink to npm-cli.js. On Windows npm.cmd is
  // a batch wrapper, never a JavaScript CLI file and must not be passed to Node.
  if(process.platform!=='win32')for(const dir of dirs){const npmLink=path.join(dir,'npm');if(fs.existsSync(npmLink))npmCandidates.push(npmLink);}
  for(const cli of npmCandidates){try{return validateTools({node,cli},root);}catch{}}
 }
 return null;
}
function assertSafeWorkspaceFile(root,name){
 const target=path.join(root,name);let lst;
 try{lst=fs.lstatSync(target);}catch(e){if(e.code==='ENOENT')return false;throw e;}
 if(lst.isSymbolicLink())throw Error('Unsafe workspace '+name+': symbolic links are not allowed.');
 const st=fs.statSync(target);
 if(!lst.isFile()||lst.isSymbolicLink()||!st.isFile()||st.nlink!==1||!inDirectory(fs.realpathSync(target),fs.realpathSync(root)))throw Error('Unsafe workspace '+name+': symbolic or hard-linked files are not allowed.');
 return true;
}
/** npm can mutate existing node_modules entries, including directory links.
 * npm ci has been observed to DELETE the contents of an external directory
 * when node_modules itself is a symlink. Reject all links BEFORE launching npm.
 * A bounded scan fails closed for an enormous or unreadable install tree. */
function assertSafeInstallTree(root,{global=false}={}){
 let scanned=0;
 const visit=(location,relative)=>{
  let st;try{st=fs.lstatSync(location);}catch(e){if(e.code==='ENOENT')return;throw e;}
  if(st.isSymbolicLink())throw Error('Unsafe npm '+relative+': symbolic link or junction may modify files outside the approved directory.');
  if(st.isFile()&&st.nlink>1)throw Error('Unsafe npm '+relative+': hard-linked file may modify external content.');
  if(!st.isDirectory())return;
  const pending=[{full:location,label:relative}];
  while(pending.length){const {full,label}=pending.pop();
   for(const entry of fs.readdirSync(full,{withFileTypes:true})){
    if(++scanned>80000)throw Error('npm install tree exceeds the safety inspection limit (80000 entries). Use the normal terminal for complex projects.');
    const child=path.join(full,entry.name),childLabel=label+'/'+entry.name,childSt=fs.lstatSync(child);
    if(childSt.isSymbolicLink()){
     // A global npm prefix legitimately contains .bin links to packages
     // installed inside that same prefix. Reject links leaving the prefix.
     let safe=false;
     if(global){try{const real=fs.realpathSync(child),rel=path.relative(root,real);safe=rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}catch{}}
     if(!safe)throw Error('Unsafe npm '+childLabel+': symbolic link or junction may modify files outside the approved directory.');
     continue;
    }
    if(childSt.isFile()&&childSt.nlink>1)throw Error('Unsafe npm '+childLabel+': hard-linked file may modify external content.');
    if(childSt.isDirectory())pending.push({full:child,label:childLabel});
   }
  }
 };
 visit(path.join(root,'node_modules'),'node_modules');
 if(global){visit(root,'global npm prefix');}
}
function assertSafeDirectoryChain(destination,label){
 if(!path.isAbsolute(destination))throw Error('npm '+label+' must be absolute');
 let current=path.resolve(destination);
 while(true){
  let st;try{st=fs.lstatSync(current);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(st?.isSymbolicLink())throw Error('Unsafe npm '+label+': a symbolic link or junction redirects package installation.');
  if(st&&!st.isDirectory())throw Error('Unsafe npm '+label+': an existing parent is not a directory.');
  const parent=path.dirname(current);if(parent===current)break;current=parent;
 }
}
function assertSafeGlobalPrefix(prefix){
 assertSafeDirectoryChain(prefix,'global prefix');
 assertSafeInstallTree(prefix,{global:true});
}

function validateDependencySpec(spec){
 const val=String(spec).trim();
 if(!val)throw Error('Empty npm dependency source.');
 // npm package aliases are allowed only when they resolve to registry names.
 if(val.startsWith('npm:')){
  if(!PACKAGE.test(val.slice(4)))throw Error('Unsupported npm alias dependency source: '+val.slice(0,80));
  return;
 }
 if(/^[a-z][a-z0-9+.-]*:/i.test(val)||/^(?:\.{1,2}[/\\]|[/\\]|~[/\\]|git@)/i.test(val)||/^[a-z0-9._-]+\/[a-z0-9._-]+(?:#.*)?$/i.test(val)||val.includes('://'))
  throw Error('External or local-file dependency source is not supported by the managed npm registry: '+val.slice(0,80));
}
function validateDependencyMap(map){if(!map)return;if(typeof map!=='object'||Array.isArray(map))throw Error('Invalid npm dependency map');for(const value of Object.values(map))validateDependencySpec(value);}
function validateLockRecord(record){
 if(!record||typeof record!=='object')return;
 if(record.link===true)throw Error('npm link dependencies are not supported in managed installs. Remove local workspace links.');
 if(Array.isArray(record.workspaces)&&record.workspaces.length)throw Error('npm workspaces are not supported in managed installs.');
 if(typeof record.resolved==='string'){
  let valid=false;
  try{const u=new URL(record.resolved);valid=u.protocol==='https:'&&u.hostname==='registry.npmjs.org'&&!u.port&&!u.username&&!u.password&&!u.hash;}catch{}
  if(!valid)throw Error('npm lockfile contains a non-official registry URL, an unsupported source, or an expired localhost relay address. Regenerate with the approved registry.');
 }
 if(typeof record.version==='string'&&/^(?:[a-z][a-z0-9+.-]*:|git@|\.{1,2}[/\\]|[/\\])/i.test(record.version)){
  validateDependencySpec(record.version);
 }
 for(const key of ['dependencies','devDependencies','optionalDependencies','peerDependencies']){
  const entries=record[key];if(!entries||typeof entries!=='object')continue;
  // The lockfile v1 dependencies map contains objects, unlike manifest ranges.
  for(const value of Object.values(entries)){
   if(typeof value==='string')validateDependencySpec(value);
   else validateLockRecord(value);
  }
 }
}
function validateOverrides(obj){
 if(!obj||typeof obj!=='object')return;
 for(const [key,value] of Object.entries(obj)){
  if(key==='.'&&typeof value==='string')validateDependencySpec(value);
  else if(typeof value==='string')validateDependencySpec(value);
  else if(value&&typeof value==='object')validateOverrides(value);
 }
}
function lifecycleWarnings(root){
 const warnings=[];
 try{if(assertSafeWorkspaceFile(root,'package.json')){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const scripts=Object.keys(manifest.scripts||{}).filter(k=>/^(?:preinstall|install|postinstall|prepare|prepack|postpack)$/.test(k));
  if(scripts.length)warnings.push('npm lifecycle scripts are disabled: workspace scripts '+scripts.join(', '));
 }}catch(e){warnings.push('Unable to inspect package lifecycle scripts: '+e.message);}
 try{if(assertSafeWorkspaceFile(root,'package-lock.json')){
  const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
  const requires=Object.entries(lock.packages||{}).filter(([,v])=>v?.hasInstallScript).map(([k])=>k);
  if(requires.length)warnings.push('npm lifecycle scripts are disabled for '+requires.slice(0,8).join(', ')+(requires.length>8?' and others':'')+'. These packages may not function until scripts are reviewed and approved independently.');
 }}catch(e){warnings.push('Unable to inspect lockfile lifecycle scripts: '+e.message);}
 return warnings;
}
function approvedUrl(input){const u=new URL(input);if(u.protocol!=='https:'||u.hostname.toLowerCase()!=='registry.npmjs.org'||u.port||u.username||u.password||u.hash)throw Error('Unapproved npm registry host');return u.href;}
/** Error details are deliberately fixed strings. Untrusted registry data must
 * never reach the status channel or the localhost HTTP response verbatim. */
function metadataError(kind,message,httpStatus=422){
 const e=new Error(message);e.kind=kind;e.httpStatus=httpStatus;return e;
}
/** npm packuments contain *every* published version. An obsolete version with
 * an unsupported Git/file runtime dependency must not disable a modern safe version.
 * Published-package devDependencies are not installed transitively: do not
 * treat their Git/SSH/test-source references as runtime dependencies.
 * Reject versions with unsafe install-time dependencies, keeping the network
 * and script-execution policy. Local workspace devDependencies stay checked.
 * Fail closed when the requested latest tag itself is unsafe. */
function rewriteMetadata(raw,localBase,files,{onRejectedVersions}={}){
 let data;
 try{data=JSON.parse(raw.toString('utf8'));}
 catch{throw metadataError('metadata-format','Invalid npm registry metadata (JSON format)',502);}
 if(!data||typeof data!=='object'||Array.isArray(data)||!data.versions||typeof data.versions!=='object'||Array.isArray(data.versions))
  throw metadataError('metadata-format','Invalid npm registry metadata (version catalog)',502);
 const valid=Object.create(null),pending=[],reasons=Object.create(null);
 let rejected=0;
 for(const [versionKey,version] of Object.entries(data.versions)){
  let target,reason;
  if(!version||typeof version!=='object'||Array.isArray(version)||typeof version.dist?.tarball!=='string')reason='missing-tarball';
  if(!reason){
   try{for(const key of ['dependencies','optionalDependencies','peerDependencies'])validateDependencyMap(version[key]);}
   catch{reason='unsupported-dependency';}
  }
  if(!reason){
   try{target=approvedUrl(version.dist.tarball);}
   catch{reason='unapproved-artifact-origin';}
  }
  if(!reason&&!new URL(target).pathname.endsWith('.tgz'))reason='unsupported-artifact-type';
  if(reason){rejected++;reasons[reason]=(reasons[reason]||0)+1;continue;}
  // npm does not install devDependencies of registry packages. Strip them
  // from the relayed install metadata to prevent unrelated development
  // sources from appearing in the managed package workflow.
  delete version.devDependencies;
  const id=crypto.createHash('sha256').update(target).digest('hex');
  pending.push([id,target,version]);
  valid[versionKey]=version;
 }
 const total=Object.keys(data.versions).length;
 onRejectedVersions?.({name:typeof data.name==='string'?data.name:'package',rejected,total,reasons:{...reasons}});
 if(!Object.keys(valid).length)throw metadataError('metadata-policy','No registry-compatible versions for this npm package. The package metadata contains disallowed dependencies or artifact locations.');
 if(data['dist-tags']&&typeof data['dist-tags']==='object'&&!Array.isArray(data['dist-tags'])){
  if(typeof data['dist-tags'].latest==='string'&&!Object.hasOwn(valid,data['dist-tags'].latest))
   throw metadataError('metadata-policy','npm package latest version is unsupported by the registry-only policy.');
  for(const [tag,version] of Object.entries(data['dist-tags']))if(!Object.hasOwn(valid,version))delete data['dist-tags'][tag];
 }
 for(const [id,target,version] of pending){
  files.set(id,target);
  version.dist.tarball=localBase+'files/'+id+'/'+encodeURIComponent(path.basename(new URL(target).pathname));
 }
 data.versions=valid;
 return data;
}

async function fetchPowerShell(url,destination,{proxyUrl,proxy,userAgent,extensionRoot,signal,maximumBytes=MAX_TARBALL,timeoutSeconds=180}={}){
 if(process.platform!=='win32')throw Error('Windows PowerShell and integrated proxy credentials are required for this npm fetch');approvedUrl(url);
 const script=path.join(extensionRoot||path.resolve(__dirname,'..'),'ps','npm-fetch.ps1');const encoded=Buffer.from(fs.readFileSync(script,'utf8'),'utf16le').toString('base64');
 const ps=cp.spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{shell:false,windowsHide:true,env:npmEnvironment(),stdio:['pipe','pipe','pipe']});let error='';ps.stderr.on('data',d=>error=(error+String(d)).slice(-2000));ps.stdout.on('data',d=>error=(error+String(d)).slice(-2000));const abort=()=>ps.kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 ps.stdin.on('error',()=>{});ps.stdin.end(JSON.stringify({url,destination,proxyUrl,proxyEnabled:proxy?.enabled!==false,proxyAuth:proxy?.auth||'computer',proxyUsername:proxy?.username||'',proxyPassword:proxy?.auth==='user'?(proxy?.password||''):'',userAgent,maximumBytes,timeoutSeconds})+'\n');
 try{const [code]=await once(ps,'close');if(signal?.aborted)throw Error('npm download cancelled');if(code)throw Error('npm upstream fetch failed: '+error.replace(/https?:\/\/[^\s@]+@/g,'[redacted]@').slice(-400));}finally{signal?.removeEventListener('abort',abort);}
}
/** Translate the Windows PowerShell helper's text into safe, actionable categories.
 * Never propagate raw PowerShell output: it can contain corporate proxy details. */
function classifyUpstreamFailure(error){
 const raw=String(error?.message||error||'');
 const found=raw.match(/\b(?:HTTP(?:\s+status)?|statusCode|status|error:)\s*[:(]?\s*([45]\d{2})\b/i)
  ||raw.match(/\(([45]\d{2})\)\s*(?:Bad Gateway|Forbidden|Unauthorized|Not Found|Proxy Authentication|Too Many Requests|Service Unavailable|Gateway Timeout|Internal Server Error)/i);
 const code=Number(error?.upstreamStatus||found?.[1]||0);
 if(code){
  const label=code===407?'proxy authentication rejected':code===401||code===403?'request denied by registry or proxy':code===404?'package not found':code===429?'rate limited':code>=500?'registry or proxy server failure':'upstream HTTP failure';
  return {kind:'http',code,retryable:code===429||[500,502,503,504].includes(code),summary:'upstream HTTP '+code+' ('+label+')'};
 }
 if(/SSL|TLS|certificate|trust relationship|CERT_|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(raw))return {kind:'tls',code:0,retryable:false,summary:'TLS/certificate validation failed'};
 if(/timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(raw))return {kind:'timeout',code:0,retryable:true,summary:'upstream connection timed out'};
 if(/ECONNRESET|ECONNABORTED|socket hang up|connection (?:reset|closed|aborted)|underlying connection was closed|unexpected EOF/i.test(raw))return {kind:'connection',code:0,retryable:true,summary:'upstream connection interrupted'};
 if(/name resolution|DNS|ENOTFOUND/i.test(raw))return {kind:'dns',code:0,retryable:false,summary:'npm registry DNS resolution failed'};
 if(/cancelled|canceled|aborted/i.test(raw))return {kind:'cancelled',code:0,retryable:false,summary:'npm request cancelled'};
 return {kind:'unknown',code:0,retryable:false,summary:'upstream PowerShell download failed (unclassified)'};
}
function abortableDelay(ms,signal){
 if(signal?.aborted)return Promise.reject(Error('npm request cancelled'));
 return new Promise((resolve,reject)=>{
  const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolve();};
  const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(Error('npm request cancelled'));};
  const timer=setTimeout(done,ms);signal?.addEventListener('abort',cancel,{once:true});
 });
}
async function startRelay({cacheDir,proxyUrl,proxy,userAgent,extensionRoot,signal,onStatus,fetchFile=fetchPowerShell,maxConcurrent=6,maxUpstreamAttempts=3,retryDelayMs=400,upstreamDeadlineMs=480000,queueWaitMs=90000,metadataTtlMs=DEFAULT_META_TTL_MS}={}){
 if(!path.isAbsolute(cacheDir||''))throw Error('Absolute npm relay cache path required');
 assertSafeDirectoryChain(cacheDir,'relay cache');await fsp.mkdir(cacheDir,{recursive:true});
 const artifactUrls=new Map(),inflight=new Map(),controllers=new Set(),waiting=[];let active=0,cachedSize=0,closed=false;
 const requests={metadata:0,tarballs:0,other:0,upstreamAttempts:0,retries:0,upstreamFailures:0,metadataVersionsRejected:0,metadataProcessingFailures:0,relayInternalFailures:0,clientDisconnects:0,clientSocketErrors:0,queueTimeouts:0,cancelledRequests:0};
 const errors=[];
 // A persistent registry cache reduces repeated corporate-proxy requests across
 // npm operations. Inspect only hashed regular files and count preexisting bytes.
 const cacheEntries=[];
 for(const entry of await fsp.readdir(cacheDir)){
  if(!/^[0-9a-f]{64}$/.test(entry))continue;
  const file=path.join(cacheDir,entry),st=await fsp.lstat(file);
  if(!st.isFile()||st.nlink!==1||st.size>MAX_TARBALL)throw Error('Unsafe npm registry cache entry');
  cacheEntries.push({file,size:st.size,modified:st.mtimeMs});cachedSize+=st.size;
  if(cacheEntries.length>20000)throw Error('npm registry cache contains too many entries');
 }
 // Bounded disk usage. Remove oldest approved cache objects, never unknown files.
 if(cachedSize>MAX_CACHE){cacheEntries.sort((a,b)=>a.modified-b.modified);
  for(const entry of cacheEntries){if(cachedSize<=Math.floor(MAX_CACHE*0.85))break;
   await fsp.unlink(entry.file);cachedSize-=entry.size;
  }
 }
 const attemptsLimit=Math.max(1,Math.min(4,Math.floor(Number(maxUpstreamAttempts)||1)));
 const baseDelay=Math.max(0,Math.min(10000,Number(retryDelayMs)||0));
 const totalDeadline=Math.max(1000,Math.min(480000,Number(upstreamDeadlineMs)||480000));
 const status=s=>{try{onStatus?.('[npm relay] '+s+'\n');}catch{}};
 // Backpressure must finish before npm's own HTTP fetch timeout. In v1.0.23
 // a request could wait indefinitely for an upstream worker without sending
 // HTTP headers, ultimately surfacing as ERR_SOCKET_TIMEOUT on localhost.
 const acquire=()=>new Promise((resolve,reject)=>{
  if(closed||signal?.aborted)return reject(Error('npm relay cancelled'));
  if(active<maxConcurrent){active++;resolve();return;}
  let timer,finished=false;
  const remove=()=>{const index=waiting.indexOf(item);if(index>=0)waiting.splice(index,1);};
  const finish=()=>{if(finished)return false;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);return true;};
  const cancel=()=>{if(!finish())return;remove();reject(Error('npm relay cancelled'));};
  const item={resolve:()=>{if(!finish())return;active++;resolve();},reject:e=>{if(!finish())return;remove();reject(e);}};
  waiting.push(item);
  const ms=Math.max(1,Math.min(90000,Number(queueWaitMs)||90000));
  timer=setTimeout(()=>{if(finished)return;requests.queueTimeouts++;const e=Error('npm relay busy: upstream download queue timed out; retry request');e.kind='relay-busy';e.httpStatus=503;item.reject(e);},ms);
  signal?.addEventListener('abort',cancel,{once:true});
 });
 const release=()=>{active--;if(waiting.length&&!closed)waiting.shift().resolve();};
 const cached=url=>{if(inflight.has(url))return inflight.get(url);const task=(async()=>{
  const max=url.endsWith('.tgz')?MAX_TARBALL:MAX_META;
  const dest=path.join(cacheDir,crypto.createHash('sha256').update(url).digest('hex'));
  const name=decodeURIComponent(new URL(url).pathname).slice(0,120);
  let existing;try{existing=await fsp.lstat(dest);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing){if(!existing.isFile()||existing.nlink!==1)throw Error('Unsafe npm relay cache entry');
   if(existing.size>0&&existing.size<=max){
    if(url.endsWith('.tgz')||Date.now()-existing.mtimeMs<metadataTtlMs){status('Cache hit '+name);return dest;}
    await fsp.unlink(dest);cachedSize-=existing.size;status('Refreshing expired metadata '+name);
   }else throw Error('Invalid npm relay cache entry');}
  const deadlineAt=Date.now()+totalDeadline,started=Date.now();
  let last;
  for(let attempt=1;attempt<=attemptsLimit;attempt++){
   if(closed||signal?.aborted)throw Error('npm request cancelled');
   const remaining=deadlineAt-Date.now();if(remaining<=0)throw Error('npm upstream deadline exceeded for '+name);
   await acquire();const remainingAfterQueue=deadlineAt-Date.now();
   if(remainingAfterQueue<=0){release();requests.queueTimeouts++;const e=Error('npm relay busy: upstream download deadline reached while queued; retry request');e.kind='relay-busy';e.httpStatus=503;throw e;}
   const controller=new AbortController();controllers.add(controller);
   const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
   const tmp=dest+'.'+crypto.randomBytes(5).toString('hex')+'.tmp';let timer;
   const fetchStarted=Date.now();requests.upstreamAttempts++;
   try{
    status('Fetching '+name+' (attempt '+attempt+'/'+attemptsLimit+')');
    const fetchPromise=Promise.resolve().then(()=>fetchFile(url,tmp,{proxyUrl,proxy,userAgent,extensionRoot,signal:controller.signal,maximumBytes:max,timeoutSeconds:Math.max(1,Math.min(180,Math.ceil(remainingAfterQueue/1000)))}));
    // Reject immediately if the deadline is reached; the fetch helper receives
    // an AbortSignal so its Windows PowerShell child can be terminated.
    await Promise.race([fetchPromise,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('npm upstream download timed out'));},remainingAfterQueue);})]);
    if(controller.signal.aborted||closed||signal?.aborted)throw Error('npm request cancelled');
    const st=await fsp.lstat(tmp);
    if(!st.isFile()||st.nlink!==1||!st.size||st.size>max||cachedSize+st.size>MAX_CACHE)throw Error('npm artifact size or file safety limit exceeded');
    await fsp.rename(tmp,dest);cachedSize+=st.size;
    status('Fetched '+name+' ('+st.size+' bytes, attempt '+attempt+'/'+attemptsLimit+', '+(Date.now()-fetchStarted)+'ms)');return dest;
   }catch(e){
    if(closed||signal?.aborted)throw Error('npm request cancelled');
    const info=classifyUpstreamFailure(e);last=info;requests.upstreamFailures++;
    const elapsed=Date.now()-fetchStarted;
    const canRetry=info.retryable&&attempt<attemptsLimit&&Date.now()<deadlineAt;
    const delay=Math.min(baseDelay*2**(attempt-1),Math.max(0,deadlineAt-Date.now()));
    status('FAILED '+name+': '+info.summary+' (attempt '+attempt+'/'+attemptsLimit+', '+elapsed+'ms).'+(canRetry?' Retrying in '+delay+'ms.':' No further retry.'));
    if(!canRetry){errors.push({package:name,category:info.kind,upstreamStatus:info.code,attempts:attempt});if(errors.length>15)errors.shift();
     const failure=Error(name+': '+info.summary+' after '+attempt+' attempt(s) in '+(Date.now()-started)+'ms');failure.upstreamStatus=info.code;failure.kind=info.kind;throw failure;}
    requests.retries++;
   }finally{clearTimeout(timer);controllers.delete(controller);signal?.removeEventListener('abort',abort);await fsp.rm(tmp,{force:true}).catch(()=>{});release();}
   await abortableDelay(Math.min(baseDelay*2**(attempt-1),Math.max(0,deadlineAt-Date.now())),signal);
  }
  throw Error('npm upstream failure: '+(last?.summary||'unknown'));
 })().finally(()=>inflight.delete(url));inflight.set(url,task);return task;};
 const server=http.createServer(async(req,res)=>{
  // A client closing its loopback socket is separate from a corporate
  // upstream failure. npm can close speculative requests or reuse a socket
  // while the server is retiring it. Track early closes without disclosing URLs.
  res.once('close',()=>{
   if(!res.writableFinished){requests.clientDisconnects++;
    if(requests.clientDisconnects<=5)status('npm client disconnected before the localhost response completed; retry is enabled.');}
  });
  const fail=(code,s)=>{if(!res.headersSent)res.writeHead(code,{'content-type':'text/plain','cache-control':'no-store'});res.end(req.method==='HEAD'?'':String(s).slice(0,400));};
  if(closed||signal?.aborted)return fail(503,'Stopped');if(!['GET','HEAD'].includes(req.method))return fail(405,'Only GET and HEAD allowed');
  try{if(req.url.startsWith('//'))return fail(400,'Invalid path');const uri=new URL(req.url,'http://localhost');if(uri.search||uri.hash)return fail(400,'Query unsupported');const loc=uri.pathname;
   if(loc.startsWith('/files/')){requests.tarballs++;const m=loc.match(/^\/files\/([0-9a-f]{64})\/([^/]{1,220})$/);const url=m&&artifactUrls.get(m[1]);if(!url||decodeURIComponent(m[2])!==path.basename(new URL(url).pathname))return fail(404,'Unknown npm artifact');
    const file=await cached(url),st=await fsp.stat(file);res.writeHead(200,{'content-type':'application/octet-stream','content-length':st.size,'cache-control':'no-store'});if(req.method==='HEAD')return res.end();return fs.createReadStream(file).pipe(res);}
   // npm ci rewrites lockfile URLs at the configured registry origin. Its
   // canonical /package/-/file.tgz paths must also be served by localhost.
   const canonical=decodeURIComponent(loc).match(/^\/(@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)\/-\/([a-z0-9][a-z0-9._~-]*\.tgz)$/i);
   if(canonical){
    requests.tarballs++;const remote=approvedUrl(REGISTRY+'/'+canonical[1]+'/-/'+canonical[2]);const file=await cached(remote),st=await fsp.stat(file);
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':st.size,'cache-control':'no-store'});
    if(req.method==='HEAD')return res.end();return fs.createReadStream(file).pipe(res);
   }
   const id=decodeURIComponent(loc.slice(1));if(!/^(@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/i.test(id))return fail(404,'Unknown route');
   requests.metadata++;const url=REGISTRY+'/'+encodeURIComponent(id);let file;
   try{file=await cached(url);}catch(e){if(e.upstreamStatus===404)return fail(404,'npm package not found');throw e;}
   const data=rewriteMetadata(await fsp.readFile(file),baseUrl,artifactUrls,{onRejectedVersions:report=>{
    requests.metadataVersionsRejected+=report.rejected;
    if(report.rejected)status('Metadata '+id+': excluded '+report.rejected+' incompatible historical version(s) of '+report.total+'; categories '+Object.entries(report.reasons).map(([k,v])=>k+'='+v).join(', '));
   }}),body=Buffer.from(JSON.stringify(data));res.writeHead(200,{'content-type':'application/json','content-length':body.length,'cache-control':'no-store'});res.end(req.method==='HEAD'?'':body);
  }catch(e){
   if(closed||signal?.aborted){requests.cancelledRequests++;return;}
   if(e.kind==='relay-busy'){
    if(requests.queueTimeouts<=5)status('WARN download queue busy; request returned HTTP 503 for npm retry.');
    return fail(503,'npm relay busy: retry request');
   }
   if(e.kind?.startsWith('metadata-')){
    requests.metadataProcessingFailures++;
    const category=e.kind;
    errors.push({package:decodeURIComponent(new URL(req.url,'http://localhost').pathname.slice(1)).slice(0,100),category,upstreamStatus:0,attempts:0});
    if(errors.length>15)errors.shift();
    status('ERROR '+category+': '+e.message);
    return fail(e.httpStatus||502,e.message);
   }
   if(!e.kind){
    requests.relayInternalFailures++;
    errors.push({package:'[relay]',category:'relay-internal',upstreamStatus:0,attempts:0});
    if(errors.length>15)errors.shift();
   }
   const detail=e.kind?String(e.message):'npm relay could not process the registry response';
   status('ERROR '+detail.slice(0,240));fail(502,detail);
  }
 });
 // npm reuses HTTP connections aggressively during large dependency installs.
 // Node's short default (historically 5s) makes a keep-alive socket reuse
 // race more likely. Longer advertised lifetime and bounded npm retries
 // handle independent loopback connection failures without altering the
 // corporate proxy downloader or its authentication behavior.
 server.keepAliveTimeout=65000;
 server.headersTimeout=70000;
 server.on('clientError',(_err,socket)=>{
  requests.clientSocketErrors++;
  if(requests.clientSocketErrors<=5)status('npm client socket error on localhost (no upstream HTTP response).');
  socket.destroy();
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const baseUrl='http://127.0.0.1:'+server.address().port+'/';
 const restoreLockfile=async root=>{
  const name=fs.existsSync(path.join(root,'npm-shrinkwrap.json'))?'npm-shrinkwrap.json':'package-lock.json';
  const lock=path.join(root,name);
  if(!assertSafeWorkspaceFile(root,name))return 0;
  const obj=JSON.parse(await fsp.readFile(lock,'utf8'));let count=0;
  const rewrite=record=>{
   if(!record||typeof record!=='object')return;
   if(typeof record.resolved==='string'){
    try{const u=new URL(record.resolved);if(u.origin===new URL(baseUrl).origin&&u.pathname.startsWith('/files/')){
     const m=u.pathname.match(/^\/files\/([a-f0-9]{64})\//);const remote=m&&artifactUrls.get(m[1]);
     if(remote){record.resolved=remote;count++;}
    }}catch{}
   }
  };
  for(const p of Object.values(obj.packages||{}))rewrite(p);
  const walk=deps=>{for(const d of Object.values(deps||{})){rewrite(d);walk(d.dependencies);}};walk(obj.dependencies);
  if(count){const temp=lock+'.whalebone-'+crypto.randomBytes(4).toString('hex');await fsp.writeFile(temp,JSON.stringify(obj,null,2)+'\n');await fsp.rename(temp,lock);status('Normalized '+count+' lockfile URLs to permanent official npm registry URLs.');}
  return count;
 };
 const close=async()=>{if(closed)return;closed=true;
  if(controllers.size||waiting.length)status('Stopping relay; cancelling '+controllers.size+' upstream download(s) and '+waiting.length+' queued request(s).');
  controllers.forEach(x=>x.abort());for(const w of waiting.splice(0))w.reject(Error('npm relay stopped'));server.closeAllConnections?.();await new Promise(done=>server.close(done));};
 const onAbort=()=>void close();signal?.addEventListener('abort',onAbort,{once:true});
 return {url:baseUrl,restoreLockfile,requestStatus:()=>({...requests,activeUpstream:active,waitingDownloads:waiting.length,errors:[...errors]}),close:async()=>{signal?.removeEventListener('abort',onAbort);await close();}};
}
/** Safely probe an npm package on the loopback relay, including a real tarball transfer.
 * This does not install or execute the package or run lifecycle scripts. */
async function probeRegistry(relayUrl,name,{verifyTarball=true,signal}={}){
 if(!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(relayUrl))throw Error('Only the local Whale Bone registry can be probed');
 const parsed=parseCommand('npm install '+name);
 const pkg=parsed.packages[0].replace(/^(@[^/]+\/[^@]+|[^@]+)@.+$/,'$1');
 const base=new URL(relayUrl),start=Date.now();
 const load=async(remote,limit,{metadata=false,expectedIntegrity}={})=>{
  const url=new URL(remote);if(url.origin!==base.origin||url.protocol!=='http:')throw Error('Registry probe rejected a remote URL');
  return new Promise((resolve,reject)=>{
   const chunks=[],hashAlgorithm=expectedIntegrity?.match(/(?:^|\s)(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)/),hash=hashAlgorithm?crypto.createHash(hashAlgorithm[1]):null;
   let total=0,settled=false;
   const done=(e,result)=>{if(settled)return;settled=true;e?reject(e):resolve(result);};
   const request=http.get(url,{signal},res=>{
    if(res.statusCode!==200){res.resume();return done(Error('npm registry probe returned HTTP '+res.statusCode+' for '+url.pathname));}
    res.on('data',part=>{total+=part.length;if(total>limit){request.destroy(Error('npm registry probe size limit exceeded'));return;}
     hash?.update(part);if(metadata)chunks.push(part);});
    res.on('end',()=>{if(settled)return;
     if(hash&&hash.digest('base64')!==hashAlgorithm[2])return done(Error('npm package tarball integrity mismatch'));
     done(null,{bytes:total,text:metadata?Buffer.concat(chunks).toString('utf8'):undefined,integrityVerified:!!hash});
    });res.on('error',e=>done(e));
   });request.setTimeout(600000,()=>request.destroy(Error('npm registry probe timed out')));
   request.on('error',e=>done(e));
  });
 };
 const result=await load(relayUrl+encodeURIComponent(pkg),MAX_META,{metadata:true});
 let doc;try{doc=JSON.parse(result.text);}catch{throw Error('npm registry metadata was not valid JSON');}
 const version=doc?.['dist-tags']?.latest;
 if(typeof version!=='string'||!doc.versions?.[version]?.dist?.tarball)throw Error('npm registry metadata has no latest-version tarball');
 const dist=doc.versions[version].dist;
 const report={name:pkg,version,metadataBytes:result.bytes,metadataMs:Date.now()-start,tarballBytes:0,integrityVerified:false};
 if(verifyTarball){const tar=await load(dist.tarball,MAX_TARBALL,{expectedIntegrity:dist.integrity});
  report.tarballBytes=tar.bytes;report.integrityVerified=tar.integrityVerified;report.tarballMs=Date.now()-start-report.metadataMs;}
 return report;
}
function registryCacheDir(){return path.join(os.homedir(),'.whalebone','npm-registry-cache');}
function userPrefix(env=process.env){return path.join(process.platform==='win32'?(env.APPDATA||path.join(os.homedir(),'AppData','Roaming')):path.join(os.homedir(),'.local'),'WhaleBone','npm-global');}
function argumentsFor(command,relayUrl,{prefix,cache,emptyConfig,globalConfig}={}){
 if(!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(relayUrl))throw Error('Only the Whale Bone local npm registry is supported');
 const args=['--registry='+relayUrl,'--userconfig='+emptyConfig,'--globalconfig='+globalConfig,'--cache='+cache,'--no-audit','--fund=false','--ignore-scripts=true','--strict-ssl=true','--engine-strict=true','--fetch-retries=2','--fetch-retry-mintimeout=1000','--fetch-retry-maxtimeout=5000','--maxsockets=6','--fetch-timeout=600000','--replace-registry-host=always'];
 if(command.global)args.push('--global','--prefix='+prefix);
 args.push(command.action,...command.packages);return args;
}
function validateLocalProject(root){
 assertSafeInstallTree(root);
 const npmrc=path.join(root,'.npmrc');
 if(assertSafeWorkspaceFile(root,'.npmrc')){
  const data=fs.readFileSync(npmrc,'utf8');
  if(/(^|\n)\s*["']?\s*(?:@[^\s="']+:registry|registry|proxy|https-proxy|userconfig|globalconfig|script-shell|ignore-scripts|prefix|cache|always-auth)\s*["']?\s*=/im.test(data))throw Error('Workspace .npmrc overrides managed registry, proxy, scripts, or configuration. Remove the conflicting setting before using npm manager.');
 }
 const manifest=path.join(root,'package.json');
 if(assertSafeWorkspaceFile(root,'package.json')){
  const info=JSON.parse(fs.readFileSync(manifest,'utf8'));
  if(info.workspaces!==undefined)throw Error('npm workspaces are not supported in managed installs. Use a non-managed npm terminal for workspace projects.');
  for(const key of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])validateDependencyMap(info[key]);
  validateOverrides(info.overrides);
 }
 for(const name of ['package-lock.json','npm-shrinkwrap.json']){
  const lock=path.join(root,name);
  if(assertSafeWorkspaceFile(root,name)){
   const info=JSON.parse(fs.readFileSync(lock,'utf8'));
   for(const [key,p] of Object.entries(info.packages||{})){
    if(key.startsWith('../')||key.startsWith('/')||key.includes('\\'))throw Error('npm lockfile references a path outside the managed project');
    validateLockRecord(p);
   }
   for(const d of Object.values(info.dependencies||{}))validateLockRecord(d);
  }
 }
}
async function runNpm({command,relayUrl,tools,root,cache,prefix,signal,onOutput,timeoutMs=45*60*1000}={}){
 if(!root||!path.isAbsolute(root)||!fs.existsSync(root))throw Error('Choose a valid workspace');if(signal?.aborted)throw Error('Cancelled');
 const cmd=typeof command==='string'?parseCommand(command):command;if(!cmd||!['install','uninstall','list','ci'].includes(cmd.action))throw Error('Invalid npm command');
 // Reparse to revalidate caller-generated requests before executing.
 const validated=parseCommand('npm '+cmd.action+(cmd.global?' -g':'')+(cmd.packages.length?' '+cmd.packages.join(' '):''));if(!validated.global)validateLocalProject(root);
 const located=tools||findNpmCli({root});if(!located)throw Error('Node.js/npm CLI not found. Install Node.js or select a valid Node.js installation.');
 const found=validateTools(located,root);
 const empty=await fsp.mkdtemp(path.join(os.tmpdir(),'whalebone-npm-config-'));const config=path.join(empty,'user.npmrc'),globalConfig=path.join(empty,'global.npmrc');await Promise.all([fsp.writeFile(config,''),fsp.writeFile(globalConfig,'')]);
 cache=cache||path.join(os.homedir(),'.whalebone','npm-cache');prefix=prefix||userPrefix();assertSafeDirectoryChain(cache,'cache');if(validated.global)assertSafeGlobalPrefix(prefix);await fsp.mkdir(cache,{recursive:true});if(validated.global)await fsp.mkdir(prefix,{recursive:true});
 const argv=[found.cli,...argumentsFor(validated,relayUrl,{prefix,cache,emptyConfig:config,globalConfig})],env=npmEnvironment();
 return new Promise((resolve,reject)=>{
  let proc,settled=false,timer,killTimer,tail='';const finish=(e,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);void fsp.rm(empty,{recursive:true,force:true});e?reject(e):resolve(value);};
  const abort=()=>{if(!proc)return;if(process.platform==='win32'&&proc.pid){const killer=cp.spawn(path.win32.join(env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(proc.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,shell:false});killer.on('error',()=>proc.kill());}else proc.kill('SIGKILL');killTimer=setTimeout(()=>finish(Error('npm operation cancelled or timed out')),5000);};
  try{validateTools(found,root);if(!validated.global)validateLocalProject(root);else assertSafeGlobalPrefix(prefix);proc=cp.spawn(found.node,argv,{cwd:validated.global?empty:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});}catch(e){finish(e);return;}
  const capture=d=>{tail=(tail+String(d)).slice(-7000);onOutput?.(String(d));};proc.stdout.on('data',capture);proc.stderr.on('data',capture);
  proc.on('error',e=>finish(e));proc.on('close',code=>finish(signal?.aborted?Error('npm operation cancelled'):code===0?null:Error('npm exited '+code+': '+tail.slice(-1400)),{code,output:tail}));
  timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
module.exports={assertSafeDirectoryChain,assertSafeInstallTree,assertSafeGlobalPrefix,parseCommand,validateLocalProject,validateTools,assertSafeWorkspaceFile,lifecycleWarnings,npmEnvironment,findNpmCli,approvedUrl,rewriteMetadata,fetchPowerShell,startRelay,classifyUpstreamFailure,probeRegistry,registryCacheDir,userPrefix,argumentsFor,runNpm};
