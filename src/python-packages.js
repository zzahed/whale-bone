'use strict';
/** Per-user Python package operations. No API transport dependency and no global pip configuration changes.
 * pip talks to a short-lived 127.0.0.1 index. Only approved public PyPI HTTPS URLs are
 * fetched by the separate Windows-integrated PowerShell proxy helper.
 */
const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');
const os=require('node:os');const http=require('node:http');const crypto=require('node:crypto');const cp=require('node:child_process');
const {once}=require('node:events');
const Requirements=require('./requirements');
// Large projects have long Simple API histories. Keep a bounded but realistic metadata cap.
const MAX_INDEX=25_000_000,MAX_WHEEL=500_000_000;
// The relay buffers the complete upstream wheel before replying to pip. Its local
// socket timeout must exceed the bounded upstream fetch deadline.
const PIP_SOCKET_TIMEOUT_SECONDS=600, UPSTREAM_FETCH_DEADLINE_MS=8*60*1000;
const PROJECT=/^[a-z0-9][a-z0-9._-]{0,150}$/i;
const validatePackage=Requirements.validateSpec;
const parseRequirements=Requirements.parseRequirements;
const parseRequirementsFile=Requirements.parseRequirementsFile;
function validateInterpreter(value){const v=String(value||'').trim();if(!v||/[\r\n\0"'|<>;&]/.test(v)||/\s-/.test(v)||v.length>1000)throw Error('Choose a Python executable, not a command line');return v;}
function candidateInterpreters(root,{platform=process.platform,configured='',active='',virtualEnv=process.env.VIRTUAL_ENV}={}){
 const candidates=[];const add=p=>{if(p&&typeof p==='string'&&!candidates.some(x=>x.toLowerCase()===p.toLowerCase()))candidates.push(p)};
 for(const name of ['.venv','venv'])add(path.join(root,name,platform==='win32'?'Scripts/python.exe':'bin/python'));
 if(active)add(active);if(configured)add(configured.replace(/\$\{workspaceFolder\}/g,root));
 if(virtualEnv)add(path.join(virtualEnv,platform==='win32'?'Scripts/python.exe':'bin/python'));
 for(const base of String(process.env.PATH||'').split(path.delimiter)){if(!base||!path.isAbsolute(base))continue;const candidate=path.join(base,platform==='win32'?'python.exe':'python');if(fs.existsSync(candidate))add(candidate);}
 return candidates;
}
function resolvedInterpreter(value,{env=process.env,platform=process.platform}={}){
 const selected=validateInterpreter(value);let absolute=selected;
 if(!path.isAbsolute(absolute)){
  if(!/^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/i.test(absolute))throw Error('Interpreter must be an absolute executable path');
  let found=null;for(const dir of String(env.PATH||'').split(path.delimiter)){if(!path.isAbsolute(dir))continue;for(const name of platform==='win32'?[selected.endsWith('.exe')?selected:selected+'.exe']: [selected]){const candidate=path.join(dir,name);if(fs.existsSync(candidate)){found=candidate;break;}}if(found)break;}
  if(!found)throw Error('Python was not found in PATH. Select the Python executable.');absolute=found;
 }
 if(!fs.existsSync(absolute)||!fs.statSync(absolute).isFile())throw Error('Python executable not found: '+absolute);
 // Preserve the venv interpreter path: resolving its symlink to the base Python
 // silently bypasses the virtual environment on Unix and can modify system Python.
 return path.resolve(absolute);
}
function pipEnvironment(base=process.env){
 const env={...base};
 // A corporate Windows machine can configure its proxy in the registry, even if
 // HTTP_PROXY is absent. Never direct pip's localhost-only relay traffic there.
 // Remove inherited proxy URLs and pip settings, then reinstate only loopback bypass.
 for(const k of Object.keys(env))if(/^PIP_|^(?:HTTP|HTTPS|ALL|NO)_PROXY$|^PYTHON(?:PATH|HOME|STARTUP|INSPECT|WARNINGS|USERBASE|BREAKPOINT|SAFEPATH)$/i.test(k))delete env[k];
 env.NO_PROXY='127.0.0.1,localhost,::1';
 env.no_proxy=env.NO_PROXY;
 // --isolated skips user/environment pip settings but still loads global and
 // interpreter/site pip.ini files. Inherited proxy, no-index and extra-index-url
 // are unsafe for a localhost-only relay. Pip interprets its OS-specific null
 // device as a command to skip ALL pip configuration files.
 // Important: Python's os.devnull on Windows is 'nul', not Node's '\\.\nul'.
 env.PIP_CONFIG_FILE=process.platform==='win32'?'nul':os.devNull;
 env.PIP_DISABLE_PIP_VERSION_CHECK='1';env.PIP_NO_INPUT='1';env.PYTHONUNBUFFERED='1';env.PYTHONSAFEPATH='1';
 return env;
}
function validateWheelhouse(root,requested='.whalebone/wheels'){
 const base=path.resolve(root),dest=path.resolve(base,requested),relative=path.relative(base,dest);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Wheel cache must be inside the current workspace');
 if(!relative.replaceAll('\\','/').startsWith('.whalebone/'))throw Error('Wheel cache must be inside .whalebone/');
 for(let p=base,parts=relative.split(path.sep),i=0;i<parts.length;i++){
  p=path.join(p,parts[i]);if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('Wheel cache cannot use symbolic links');
 }
 return dest;
}
function pipArgs(action,packages,{indexUrl,wheelhouse,offline=false,userSite=false,requirementsFile}={}){
 if(!['install','upgrade','uninstall','download','list','version'].includes(action))throw Error('Unsupported package operation');
 if(!Array.isArray(packages))throw Error('Expected package specifications');
 if(['install','upgrade','uninstall','download'].includes(action)){
  const maximum=requirementsFile&&action==='install'?Requirements.MAX_REQUIREMENTS:120;
  if(!packages.length||packages.length>maximum)throw Error('Choose 1 to '+maximum+' packages'+(requirementsFile?' from a validated requirements file':''));packages.forEach(validatePackage);
 }
 // Explicitly disable a configured proxy even if an older pip implementation
 // or machine policy unexpectedly attempts to load another configuration source.
 // This applies only to pip subprocesses; it does not change corporate networking
 // or the upstream Windows-integrated PowerShell fetch helper.
 const args=['-m','pip','--isolated','--proxy='];
 if(action==='version')return args.concat(['--version']);
 if(action==='list')return args.concat(['list','--format=json','--disable-pip-version-check']);
 if(action==='uninstall')return args.concat(['uninstall','--yes','--disable-pip-version-check',...packages]);
 args.push(action==='download'?'download':'install','--disable-pip-version-check','--no-input','--no-cache-dir','--retries','0','--timeout',String(PIP_SOCKET_TIMEOUT_SECONDS),'--only-binary=:all:');
 if(action==='upgrade')args.push('--upgrade');
 if(userSite&&action!=='download')args.push('--user');
 if(requirementsFile&&(action!=='install'||!path.isAbsolute(requirementsFile)))throw Error('A validated requirements file is only supported for installations');
 if(offline){if(!wheelhouse||!path.isAbsolute(wheelhouse))throw Error('Select an absolute wheel cache directory');args.push('--no-index','--find-links',wheelhouse);}
 else{if(!/^http:\/\/127\.0\.0\.1:\d+\/simple\/$/.test(indexUrl||''))throw Error('The pip index must be the local Whale Bone relay');args.push('--index-url',indexUrl,'--trusted-host','127.0.0.1');}
 if(action==='download'){if(!wheelhouse||!path.isAbsolute(wheelhouse))throw Error('Choose a wheel cache directory');args.push('--dest',wheelhouse);}
 return requirementsFile?args.concat(['--requirement',requirementsFile]):args.concat(packages);
}
function allowedUpstream(raw){const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||url.port||!['pypi.org','files.pythonhosted.org'].includes(url.hostname.toLowerCase()))throw Error('PyPI relay rejected an unapproved download host');return url.href.split('#')[0];}
function quoteAttr(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
/** Fetch one URL through the Windows-integrated corporate proxy using a separate helper.
 * No PowerShell code is built from remote HTML, package text or shell strings.
 */
async function fetchPowerShell(url,destination,{proxyUrl,proxy,userAgent,timeoutSeconds=90,signal,extensionRoot}={}){
 if(process.platform!=='win32')throw Error('Authenticated PyPI relay requires a local Windows PowerShell 5.1 host');
 allowedUpstream(url);const script=path.join(extensionRoot||path.resolve(__dirname,'..'),'ps','pypi-fetch.ps1');
 const code=fs.readFileSync(script,'utf8');const encoded=Buffer.from(code,'utf16le').toString('base64');
 const ps=cp.spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:pipEnvironment(),shell:false});
 let stderr='',stdout='';ps.stderr.setEncoding('utf8');ps.stdout.setEncoding('utf8');ps.stderr.on('data',d=>stderr=(stderr+d).slice(-3000));ps.stdout.on('data',d=>stdout=(stdout+d).slice(-3000));
 const abort=()=>{ps.kill();};if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
 ps.stdin.on('error',()=>{});ps.stdin.end(JSON.stringify({url,destination,proxyUrl,proxyEnabled:proxy?.enabled!==false,proxyAuth:proxy?.auth||'computer',proxyUsername:proxy?.username||'',proxyPassword:proxy?.auth==='user'?(proxy?.password||''):'',userAgent,timeoutSeconds,maximumBytes:url.includes('pypi.org/simple/')?MAX_INDEX:MAX_WHEEL})+'\n');
 try{const [code]=await once(ps,'close');if(signal?.aborted)throw Error('Package download cancelled');if(code!==0)throw Error('Package download failed: '+(stderr||stdout||'PowerShell exited '+code).replace(/https?:\/\/[^\s@]+@/g,'[redacted]@').slice(0,600));}
 finally{signal?.removeEventListener('abort',abort);}
}
async function startRelay({cacheDir,proxyUrl,proxy,userAgent,signal,fetchFile=fetchPowerShell,extensionRoot,maxConcurrent=4,onStatus,upstreamFetchTimeoutMs=UPSTREAM_FETCH_DEADLINE_MS,maxUpstreamAttempts=3}={}){
 if(!cacheDir||!path.isAbsolute(cacheDir))throw Error('Relay needs an absolute temporary cache directory');if(signal?.aborted)throw Error('Package operation was cancelled');
 await fsp.mkdir(cacheDir,{recursive:true});const inflight=new Map(),downloadPaths=new Map(),controllers=new Set();let closed=false,active=0;
 const waiters=[];let cachedBytes=0;const indexInfo=Object.create(null),relayErrors=[];const requests={total:0,index:0,files:0,other:0};
 const status=message=>{try{onStatus?.('[PyPI relay] '+message+'\n');}catch{}};
 const nameFor=url=>{try{return path.basename(new URL(url).pathname).slice(0,140)||'index';}catch{return 'artifact';}};
 const isRetryable=e=>/timed?\s*out|timeout|ECONNRESET|socket hang up|HTTP 50[234]|connection reset|unexpected EOF|connection closed/i.test(String(e?.message||e));
 const safeError=e=>String(e?.message||e||'Unknown upstream failure').replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi,'https://[credentials]@').slice(0,320);
 const noteFailure=(stage,e)=>{relayErrors.push(stage+': '+safeError(e));if(relayErrors.length>12)relayErrors.shift();};
 const slot=async()=>{if(closed||signal?.aborted)throw Error('Relay stopped');if(active>=maxConcurrent)await new Promise((resolve,reject)=>waiters.push({resolve,reject}));if(closed||signal?.aborted)throw Error('Relay stopped');active++;return ()=>{active--;const item=waiters.shift();item?.resolve();};};
 const cached=async(url,maxBytes)=>{url=allowedUpstream(url);if(inflight.has(url))return inflight.get(url);const key=crypto.createHash('sha256').update(url).digest('hex');const output=path.join(cacheDir,key);const promise=(async()=>{
  try{const s=await fsp.stat(output);if(s.size>0&&s.size<=maxBytes)return output;}catch{}
  const release=await slot();const name=nameFor(url),attemptLimit=Math.max(1,Math.min(3,Math.floor(Number(maxUpstreamAttempts)||1))),totalDeadlineAt=Date.now()+Math.max(1,Number(upstreamFetchTimeoutMs)||UPSTREAM_FETCH_DEADLINE_MS);
  try{
   for(let attempt=1;attempt<=attemptLimit;attempt++){
    if(closed||signal?.aborted)throw Error('Package operation cancelled');
    const remainingMs=totalDeadlineAt-Date.now();if(remainingMs<=0)throw Error('Upstream download deadline exceeded for '+name);
    const temp=output+'.'+crypto.randomBytes(5).toString('hex')+'.part';
    const controller=new AbortController();controllers.add(controller);
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const started=Date.now();let deadlineTimer,progressTimer,abortHandler;
    try{
     status('Fetching '+name+' from approved PyPI host (attempt '+attempt+'/'+attemptLimit+'). The local pip response starts after upstream download completes.');
     const deadline=new Promise((_,reject)=>{
      deadlineTimer=setTimeout(()=>{reject(Error('Upstream download deadline exceeded after '+Math.round(upstreamFetchTimeoutMs/1000)+' seconds total: '+name));controller.abort();},remainingMs);
     });
     progressTimer=setInterval(()=>status('Still fetching '+name+' ('+Math.round((Date.now()-started)/1000)+' seconds; corporate proxy/endpoint scanning may be delaying the response).'),60000);
     progressTimer.unref?.();
     const cancelled=new Promise((_,reject)=>{abortHandler=()=>reject(Error('Package operation cancelled'));controller.signal.addEventListener('abort',abortHandler,{once:true});});
     await Promise.race([fetchFile(url,temp,{proxyUrl,proxy,userAgent,signal:controller.signal,extensionRoot}),deadline,cancelled]);
     if(closed||signal?.aborted||controller.signal.aborted)throw Error('Package operation cancelled');
     const info=await fsp.stat(temp);
     if(!info.size||info.size>maxBytes)throw Error('Download exceeds relay size limit');
     if(cachedBytes+info.size>1_500_000_000)throw Error('PyPI relay reached its temporary cache size limit');
     await fsp.rename(temp,output);cachedBytes+=info.size;
     status('Completed '+name+' ('+info.size+' bytes, '+Math.round((Date.now()-started)/1000)+' seconds).');return output;
    }catch(e){
     if(closed||signal?.aborted)throw Error('Package operation cancelled');
     if(attempt>=attemptLimit||!isRetryable(e))throw e;
     status('Transient upstream failure fetching '+name+': '+safeError(e)+'. Retrying with Windows proxy authentication.');
     await new Promise(resolve=>setTimeout(resolve,Math.min(1000*attempt,3000)));
    }finally{
     clearTimeout(deadlineTimer);clearInterval(progressTimer);if(abortHandler)controller.signal.removeEventListener('abort',abortHandler);
     signal?.removeEventListener('abort',abort);controllers.delete(controller);
     await fsp.rm(temp,{force:true}).catch(()=>{});
    }
   }
  }finally{release();}
 })().finally(()=>inflight.delete(url));inflight.set(url,promise);return promise;};
 const index=async project=>{
  if(!PROJECT.test(project))throw Error('Invalid package name');const normalized=project.toLowerCase().replace(/[-_.]+/g,'-');const url='https://pypi.org/simple/'+encodeURIComponent(normalized)+'/';const file=await cached(url,MAX_INDEX);let html=await fsp.readFile(file,'utf8');
  // PEP 503: preserve link hashes and data-requires-python; forward only approved HTTPS artifact URLs.
  let links=0;
  html=html.replace(/\bhref\s*=\s*(["'])([^"']+)\1/gi,(whole,q,value)=>{
   try{const unescaped=value.replace(/&amp;/g,'&');const resolved=new URL(unescaped,url);const originalHash=resolved.hash;const remote=allowedUpstream(resolved.href);if(resolved.hostname.toLowerCase()!=='files.pythonhosted.org')return 'href="#blocked"';const id=crypto.createHash('sha256').update(remote).digest('hex');downloadPaths.set(id,remote);links++;return 'href="/files/'+id+'/'+encodeURIComponent(path.basename(resolved.pathname))+quoteAttr(originalHash)+'"';}catch{return 'href="#blocked"';}
  });
  indexInfo[normalized]={links,bytes:Buffer.byteLength(html)};
  if(!links)throw Error('PyPI package index for '+normalized+' contained no valid package links. An enterprise proxy sign-in page, blocked User-Agent, stale cache, or unexpected response may have replaced the PyPI index.');
  return html;
 };
 const server=http.createServer(async(req,res)=>{
  const respond=(status,body)=>{if(!res.headersSent)res.writeHead(status,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(req.method==='HEAD'?'':body);};
  if(closed||signal?.aborted)return respond(503,'Package relay stopped');if(!['GET','HEAD'].includes(req.method))return respond(405,'Unsupported request');
  try{
   const pathname=new URL(req.url,'http://localhost').pathname;
   const project=pathname.match(/^\/simple\/([a-zA-Z0-9._-]{1,151})\/$/);
   requests.total++;
   if(project){
    requests.index++;
    let html;try{html=await index(project[1]);}
    catch(e){
     if(/\b404\b|\bnot found\b/i.test(String(e.message))){const name=project[1].toLowerCase().replace(/[-_.]+/g,'-');indexInfo[name]={links:0,notFound:true};return respond(404,'Project '+name+' is not published on public PyPI');}
     noteFailure('Index '+project[1],e);throw e;
    }
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(req.method==='HEAD'?'':html);
   }
   const blob=pathname.match(/^\/files\/([a-f0-9]{64})\/([^/]{1,220})$/);
   if(blob){requests.files++;const remote=downloadPaths.get(blob[1]);if(!remote)return respond(404,'Not found');const expected=encodeURIComponent(path.basename(new URL(remote).pathname));const extra=blob[2]===expected?'':blob[2]===expected+'.metadata'?'.metadata':null;if(extra===null)return respond(404,'Not found');let dest;try{dest=await cached(remote+extra,MAX_WHEEL);}catch(e){noteFailure('Artifact '+path.basename(new URL(remote).pathname),e);throw e;}const s=await fsp.stat(dest);res.writeHead(200,{'content-type':'application/octet-stream','content-length':s.size,'cache-control':'no-store'});if(req.method==='HEAD')return res.end();const read=fs.createReadStream(dest);read.on('error',()=>res.destroy());return read.pipe(res);}
   requests.other++;
   if(pathname==='/simple/')return respond(200,'Whale Bone local PyPI package index. Request /simple/<package>/');
   return respond(404,'Not found');
  }catch(e){return respond(/(unapproved|Invalid package|limit)/i.test(e.message)?400:502,String(e.message).slice(0,350));}
 });
 server.on('clientError',(_err,socket)=>socket.destroy());
 server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port+'/';
 const close=async()=>{if(closed)return;closed=true;controllers.forEach(c=>c.abort());for(const w of waiters.splice(0))w.reject(Error('Relay stopped'));server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));};
 const onAbort=()=>void close();signal?.addEventListener('abort',onAbort,{once:true});
 return {url,indexUrl:url+'simple/',failureSummary:()=>relayErrors.join(' | ').slice(-1400),indexStatus:()=>({...indexInfo}),requestStatus:()=>({...requests}),close:async()=>{signal?.removeEventListener('abort',onAbort);await close();}};
}
/** Execute Python out of the repository directory. Using cwd:root with python -m pip
 * or -m venv imports an attacker-supplied workspace pip/venv package first.
 * A private temporary cwd prevents this even on Python older than 3.11.
 */
function runProcess(executable,args,{cwd,signal,onOutput,timeoutMs=10*60*1000,env=pipEnvironment()}={}){
 if(signal?.aborted)return Promise.reject(Error('Cancelled'));
 if(cwd && (!path.isAbsolute(cwd)||!fs.existsSync(cwd)))return Promise.reject(Error('Python workspace does not exist'));
 const isolatedCwd=fs.mkdtempSync(path.join(os.tmpdir(),'whalebone-python-cwd-'));
 const cleanEnv=pipEnvironment(env);
 return new Promise((resolve,reject)=>{
  let proc;try{proc=cp.spawn(executable,args,{cwd:isolatedCwd,env:cleanEnv,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});}
  catch(e){fs.rmSync(isolatedCwd,{recursive:true,force:true});reject(e);return;}
  let out='',error='',settled=false,timedOut=false,finalTimer;
  const stop=()=>{
   if(settled)return;
   if(process.platform==='win32'&&proc.pid){
    const systemRoot=cleanEnv.SystemRoot||cleanEnv.WINDIR||'C:\\Windows';
    const killer=cp.spawn(path.win32.join(systemRoot,'System32','taskkill.exe'),['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});killer.on('error',()=>{try{proc.kill();}catch{}});
   }else{try{proc.kill('SIGKILL');}catch{}}
   // Never leave the UI pending indefinitely if an endpoint protection agent
   // prevents a close event after termination was requested.
   finalTimer??=setTimeout(()=>finish(Error(signal?.aborted?'Cancelled':'Python process did not exit after cancellation/timeout')),4000);
  };
  const timeout=setTimeout(()=>{timedOut=true;stop();},timeoutMs);const handler=()=>stop();signal?.addEventListener('abort',handler,{once:true});
  const capture=(stream,isErr)=>stream?.on('data',chunk=>{const s=String(chunk);if(isErr)error=(error+s).slice(-50000);else out=(out+s).slice(-1000000);onOutput?.(s);});capture(proc.stdout,false);capture(proc.stderr,true);
  proc.once('error',e=>finish(e));proc.once('close',code=>finish(signal?.aborted?Error('Cancelled'):timedOut?Error('Python package operation exceeded its time limit'):code===0?null:Error('Python process exited '+code+': '+error.slice(-1300)),{code,stdout:out,stderr:error}));
  function finish(err,value){if(settled)return;settled=true;clearTimeout(timeout);clearTimeout(finalTimer);signal?.removeEventListener('abort',handler);
   try{fs.rmSync(isolatedCwd,{recursive:true,force:true});}catch{}if(err)reject(err);else resolve(value);}
 });
}
// Verify the *selected Python process* can reach the local Node relay before
// invoking pip. The JS extension host reaching localhost is not sufficient.
// This requests only /simple/ (a synthetic local endpoint), never public PyPI.
async function probePythonLoopback({interpreter,root,indexUrl,signal}={}){
 const executable=resolvedInterpreter(interpreter);
 if(!/^http:\/\/127\.0\.0\.1:\d+\/simple\/$/.test(indexUrl||''))throw Error('Python loopback test requires the local Whale Bone package index');
 const script='import sys,urllib.request\n'+
  'try:\n'+
  ' r=urllib.request.urlopen(sys.argv[1],timeout=6)\n'+
  ' with r: body=r.read(200).decode("utf-8","replace")\n'+
  ' if r.status != 200 or "Whale Bone local PyPI package index" not in body: raise RuntimeError("Unexpected local relay response")\n'+
  ' print("WB_LOOPBACK_OK")\n'+
  'except Exception as e:\n'+
  ' print("WB_LOOPBACK_ERROR:",type(e).__name__,str(e)[:220],file=sys.stderr)\n'+
  ' sys.exit(2)\n';
 try{
  const result=await runProcess(executable,['-I','-c',script,indexUrl],{cwd:root||path.dirname(executable),signal,timeoutMs:14000});
  if(!result.stdout.includes('WB_LOOPBACK_OK'))throw Error('Python did not confirm local relay access');
  return {reachable:true};
 }catch(e){
  throw Error('Selected Python could not reach Whale Bone localhost relay (127.0.0.1). '+
   'The Python process may be blocked by endpoint protection or proxy routing. '+
   'Corporate proxy credentials are NOT needed for localhost. Diagnostic: '+String(e.message).slice(-550));
 }
}
/** Long imports are cancellable, but need more time than one-package installs behind NTLM proxies. */
function pipOperationTimeoutMs(count=1){const n=Math.max(1,Math.min(Requirements.MAX_REQUIREMENTS,Number(count)||1));return Math.min(120,35+Math.floor(n/150)*15)*60*1000;}
/** Explain the pip resolver result without mislabeling every package in a large manifest.
 * An index containing links does not establish that the selected wheel or version exists. */
function pipResolutionDiagnostic(message,indexInfo={},requirementCount=0){
 const raw=String(message||'');
 const missing=[...raw.matchAll(/(?:No matching distribution found for|Could not find a version that satisfies the requirement)\s+([^\r\n(]+?)(?:\s+\(from versions:|\r?$|\n)/gmi)].map(m=>m[1].trim());
 const target=missing.find(x=>x.length&&x.length<250)||'';
 const count=Number.isInteger(requirementCount)&&requirementCount>0?requirementCount:0;
 const context=count>0?' while processing '+count+' requirement'+(count===1?'':'s'):'';
 if(target){
  const project=target.match(/^[a-zA-Z0-9._-]+/)?.[0]?.toLowerCase().replace(/[-_.]+/g,'-');
  const stat=project?indexInfo[project]:null;
  const indexNote=stat?.notFound?' Package is absent from the approved PyPI index.':stat?(' Index returned '+stat.links+' artifact links; this does not prove a matching version or wheel exists.'):'';
  return 'Pip could not resolve '+target+context+'.'+indexNote+' Check the exact pinned version, Python version, operating system/architecture, and whether a compatible wheel exists. Whale Bone currently uses wheel-only installs; source-only releases cannot be installed.';
 }
 return 'Pip could not resolve the selected package set'+context+'. Check the final pip ERROR lines in Whale Bone: Python Packages output. A pinned version, environment marker, unavailable wheel, or dependency conflict may be responsible.';
}
function requirementsHashWarning(imported){
 if(!imported?.hasHashes)return '';
 const missing=Number(imported.unhashedCount)||0;
 if(missing)return 'SHA-256 hash mode is enabled, but '+missing+' unhashed requirement(s) remain without --hash. Pip requires hashes and exact version pins for all applicable requirements and dependencies. Complete the hashes before installation.';
 return 'SHA-256 hash mode is enabled. Pip also requires exact pins and hashes for all transitive dependencies; missing dependency hashes can prevent installation.';
}
async function runPip({interpreter,root,action,packages=[],proxyUrl,proxy,userAgent,offline=false,wheelhouse,userSite=false,requirementsText,signal,onOutput,extensionRoot,fetchFile}={}){
 const executable=resolvedInterpreter(interpreter);const dir=root||path.dirname(executable);if(!fs.statSync(dir).isDirectory())throw Error('Python workspace does not exist');
 if(requirementsText!==undefined){
  const requirementLines=String(requirementsText).split(/\r?\n/).filter(Boolean);
  if(requirementLines.some(line=>/\s--hash=sha256:/i.test(line))&&requirementLines.some(line=>!/\s--hash=sha256:/i.test(line)))
    throw Error('Incomplete SHA-256 hash mode: at least one requirement is missing --hash. Pin and hash every requirement and applicable dependency before installing.');
 }
 if(action==='uninstall'||action==='list'||action==='version')return runProcess(executable,pipArgs(action,packages),{cwd:dir,signal,onOutput});
 let relay=null,cache=null,manifestDir=null;try{
  if(!offline){cache=await fsp.mkdtemp(path.join(os.tmpdir(),'whalebone-pypi-'));relay=await startRelay({cacheDir:cache,proxyUrl,proxy,userAgent,signal,extensionRoot,fetchFile,onStatus:message=>onOutput?.(message)});await probePythonLoopback({interpreter:executable,root:dir,indexUrl:relay.indexUrl,signal});}
  let requirementsFile;
  if(requirementsText!==undefined){
   if(action!=='install'||typeof requirementsText!=='string'||requirementsText.length>Requirements.MAX_TOTAL_REQUIREMENTS_BYTES||!packages.length||packages.length>Requirements.MAX_REQUIREMENTS)throw Error('Invalid imported requirements');
   // The imported manifest has already been flattened and validated by parseRequirementsFile.
   // Recheck its lines before putting them into a temporary pip-only requirements file.
   for(const line of requirementsText.split(/\r?\n/).filter(Boolean)){
    const spec=line.split(/\s+(?=--hash(?:=|\s))/i)[0];validatePackage(spec);
    if(!/^([^\r\n]+?)(?:\s+--hash=sha256:[a-f0-9]{64})*$/i.test(line))throw Error('Invalid imported requirements content');
   }
   manifestDir=await fsp.mkdtemp(path.join(os.tmpdir(),'whalebone-req-'));
   requirementsFile=path.join(manifestDir,'requirements.txt');await fsp.writeFile(requirementsFile,requirementsText,{mode:0o600});
  }
  const args=pipArgs(action,packages,{indexUrl:relay?.indexUrl,wheelhouse,offline,userSite,requirementsFile});
  try{return await runProcess(executable,args,{cwd:dir,signal,onOutput,timeoutMs:requirementsText===undefined?35*60*1000:pipOperationTimeoutMs(packages.length)});}
  catch(e){
   const upstream=relay?.failureSummary();
   if(upstream)throw Error('PyPI relay failure: '+upstream+'. Pip may report \"from versions: none\" when upstream access is blocked. Inspect the precise relay error before changing package versions.');
   const info=relay?.indexStatus()||{},traffic=relay?.requestStatus();
   if(/no matching distribution|could not find a version/i.test(e.message)&&traffic&&traffic.index===0){
    throw Error('Python loopback preflight succeeded, but pip sent 0 requests to the Whale Bone index ('+traffic.total+' relay requests total). Whale Bone disabled inherited pip configuration files and explicit pip proxies. Inspect the selected interpreter, pip startup hooks and endpoint security for localhost interception. '+String(e.message).slice(-450));
   }
   const missing=Object.entries(info).filter(([,stat])=>stat.notFound).map(([name])=>name);
   if(missing.length)throw Error('Package not found on public PyPI: '+missing.join(', ')+'. Check the package spelling. This is a package-name error, not a proxy credential failure.');
   if(/no matching distribution|could not find a version/i.test(e.message)&&Object.keys(info).length){
    throw Error(pipResolutionDiagnostic(e.message,info,packages.length)+' Original pip error: '+String(e.message).slice(-600));
   }
   throw e;
  }
 }finally{await relay?.close();if(cache)await fsp.rm(cache,{force:true,recursive:true,maxRetries:2}).catch(()=>{});if(manifestDir)await fsp.rm(manifestDir,{force:true,recursive:true,maxRetries:2}).catch(()=>{});}
}
module.exports={validatePackage,parseRequirements,parseRequirementsFile,validateInterpreter,candidateInterpreters,resolvedInterpreter,pipEnvironment,validateWheelhouse,pipArgs,allowedUpstream,startRelay,fetchPowerShell,runProcess,probePythonLoopback,pipResolutionDiagnostic,pipOperationTimeoutMs,requirementsHashWarning,runPip};
