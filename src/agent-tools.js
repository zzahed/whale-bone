'use strict';
/** Explicitly approved, fixed-argv tests. Running tests executes repository code. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{StringDecoder}=require('node:string_decoder');
const ALLOWED=new Map([
 ['python -m unittest discover',{exe:'python',args:['-m','unittest','discover']}],
 ['python -m pytest',{exe:'python',args:['-m','pytest']}],
 ['py -m unittest discover',{exe:'py',args:['-m','unittest','discover']}],
 ['py -m pytest',{exe:'py',args:['-m','pytest']}],
 ['node --test',{exe:'node',args:['--test']}]
]);
function parseAllowed(input){return ALLOWED.has(input)?{...ALLOWED.get(input),args:[...ALLOWED.get(input).args]}:null;}
function normalizeTimeout(ms){return Math.min(600000,Math.max(1000,Number.isFinite(ms)?Math.round(ms):180000));}
function isWithin(parent,child){const rel=path.relative(parent,child);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
function resolveExecutable(name,root){
 // In VS Code the extension host is Electron: process.execPath can be Code.exe, not node.exe.
 if(name==='node'&&/^node(?:\.exe)?$/i.test(path.basename(process.execPath)))return fs.realpathSync(process.execPath);
 if(!['python','py','npm','node'].includes(name))throw Error('Unsupported test executable');
 const isWin=process.platform==='win32';const ext=isWin?'.exe':'';
 const search=(process.env.PATH||process.env.Path||'').split(path.delimiter);
 for(const dir of search){
  const clean=dir.trim().replace(/^"|"$/g,'');if(!clean||!path.isAbsolute(clean))continue;
  try{const folder=fs.realpathSync(clean);const candidate=fs.realpathSync(path.join(folder,name+ext));
   if(isWithin(fs.realpathSync(root),candidate))continue;
   if(!fs.statSync(candidate).isFile())continue;
   if(!isWin){fs.accessSync(candidate,fs.constants.X_OK);}
   return candidate;
  }catch{}
 }
 throw Error(`Approved ${name} executable was not found outside the workspace in system PATH. Configure an approved interpreter installation.`);
}
/** Terminate an entire test process tree on Windows and the process group on Unix.
 * This limits leaks on timeout, but cannot sandbox malicious test code. */
function stopProcessTree(child,{platform=process.platform,killer=spawn}={}){
 if(!child)return;
 if(platform==='win32'&&Number.isInteger(child.pid)&&child.pid>0){
  const sys=process.env.SystemRoot||process.env.WINDIR||'C:\\Windows';
  const taskkill=path.win32.join(sys,'System32','taskkill.exe');
  try{const k=killer(taskkill,['/T','/F','/PID',String(child.pid)],{windowsHide:true,shell:false,stdio:'ignore'});k?.on?.('error',()=>{try{child.kill();}catch{}});return;}catch{}
 }
 if(platform!=='win32'&&Number.isInteger(child.pid)&&child.pid>0){try{process.kill(-child.pid,'SIGKILL');return;}catch{}}
 try{child.kill();}catch{}
}
async function runApprovedTest({root,command,enabled=false,approve,signal,executor=spawn,timeoutMs=180000,resolveExe=resolveExecutable}){
 const args=parseAllowed(command);if(!enabled)throw Error('Agent test execution is disabled in Whale Bone settings.');
 if(!args)throw Error('Command not allowlisted. No shell or arbitrary arguments permitted.');
 if(signal?.aborted)throw Error('Request cancelled');
 // Resolve the exact executable before user authorization so that its identity is disclosed.
 const exe=resolveExe(args.exe,root);
 if(!path.isAbsolute(exe))throw Error('Approved test executable must resolve to an absolute path');
 if(typeof approve!=='function'||!await approve(command,exe)){const denied=Error('User did not authorize this test command.');denied.code='WHALEBONE_TEST_DECLINED';throw denied;}
 if(signal?.aborted)throw Error('Request cancelled');
 // Windows .cmd files require shell execution. Never invoke cmd.exe to run npm packages.
 if(process.platform==='win32'&&args.exe==='npm')throw Error('Shell-free npm execution is not supported on this host. Use node --test or Python test commands.');
 // Refuse replacement of the executable between consent and execution.
 if(resolveExe(args.exe,root)!==exe)throw Error('Test executable changed after approval; approve it again');
 return new Promise((resolve,reject)=>{
  let finished=false,stdout='',stderr='';const safeEnv={CI:'1',NO_COLOR:'1'};
  for(const name of ['PATH','Path','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','VIRTUAL_ENV'])if(process.env[name]!==undefined)safeEnv[name]=process.env[name];
  let child;try{child=executor(exe,args.args,{cwd:root,windowsHide:true,shell:false,detached:process.platform!=='win32',env:safeEnv,stdio:['ignore','pipe','pipe']});}catch(e){reject(Error('Unable to start approved runner: '+e.message));return;}
  const finish=(err,result)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener?.('abort',abort);if(err)reject(err);else resolve(result);};
  const abort=()=>{stopProcessTree(child);finish(Error('Request cancelled'))};
  const timer=setTimeout(()=>{stopProcessTree(child);finish(Error('Approved test command exceeded '+Math.round(normalizeTimeout(timeoutMs)/1000)+' seconds; attempted to terminate its process tree'))},normalizeTimeout(timeoutMs));
  signal?.addEventListener?.('abort',abort,{once:true});
  const outDecoder=new StringDecoder('utf8'),errDecoder=new StringDecoder('utf8');
  child.stdout?.on('data',chunk=>{stdout=(stdout+outDecoder.write(chunk)).slice(-18000);});
  child.stderr?.on('data',chunk=>{stderr=(stderr+errDecoder.write(chunk)).slice(-4000);});
  child.on('error',e=>finish(Error('Cannot execute approved test: '+e.message)));
  child.on('close',code=>{stdout+=outDecoder.end();stderr+=errDecoder.end();finish(null,{command,exitCode:Number.isInteger(code)?code:-1,stdout:stdout.slice(-12000),stderr:stderr.slice(-2000)});});
 });
}
module.exports={ALLOWED,parseAllowed,normalizeTimeout,resolveExecutable,stopProcessTree,runApprovedTest};
