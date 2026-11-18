'use strict';
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');const {StringDecoder}=require('node:string_decoder');
const LEGACY_AGENT='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
function validateEndpoint(url){if(!String(url??'').trim())throw Error('Set the API URL (an HTTPS endpoint ending /v1) in Whale Bone settings');let u;try{u=new URL(url)}catch{throw Error('Invalid API endpoint');}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!u.pathname.endsWith('/v1'))throw Error('API URL must be an HTTPS endpoint ending /v1');
 return u.toString().replace(/\/$/,'');}
function validateProxy(text){let raw=String(text??'').trim();if(!raw)return '';if(!/^https?:\/\//.test(raw))raw='http://'+raw;let u;try{u=new URL(raw)}catch{throw Error('Invalid proxy address');}
 if(!['http:','https:'].includes(u.protocol)||!u.hostname||!u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Proxy must be hostname:port without credentials or paths');return u.toString().replace(/\/$/,'');}
const PROXY_AUTH_MODES=['computer','user','none'];
/** computer = Windows-integrated credentials of the signed-in user; user = explicit username/password; none = anonymous proxy. */
function validateProxyAuth(mode,username,enabled=true){
 if(!PROXY_AUTH_MODES.includes(mode))throw Error('Proxy authentication must be computer, user, or none');
 const name=String(username??'').trim();
 if(name.length>256||/[\r\n\0]/.test(name))throw Error('Invalid proxy username');
 if(enabled&&mode==='user'&&!name)throw Error('Enter a proxy username for user proxy authentication');
 return name;}
/** Proxy fields for a transport or relay request. Never includes the password. */
function proxyFields(c={}){return {proxyEnabled:c.proxyEnabled!==false,proxyUrl:c.proxyUrl||'',proxyAuth:c.proxyAuth||'computer',proxyUsername:c.proxyUsername||''};}
class ApiTransport{
  constructor(basePath,executor=spawn){this.ps=fs.readFileSync(path.join(basePath,'ps','transport.ps1'),'utf8');this.encoded=Buffer.from(this.ps,'utf16le').toString('base64');this.spawn=executor;}
  request({url,method='POST',apiKey,authMode='x-api-key',proxyUrl='',proxyEnabled=true,proxyAuth='computer',proxyUsername='',proxyPassword,timeoutSeconds=180,userAgent=LEGACY_AGENT,body,signal}){
    if(process.platform!=='win32')return Promise.reject(Error('API transport requires Windows PowerShell'));if(signal?.aborted)return Promise.reject(Error('Request cancelled'));
    if(!['GET','POST'].includes(method))return Promise.reject(Error('Unsupported HTTP method'));
    if(!/^https:\/\//.test(url)||!String(apiKey||'').trim())return Promise.reject(Error('HTTPS endpoint and API key required'));
    const useProxy=proxyEnabled!==false,userProxy=useProxy&&proxyAuth==='user';
    if(useProxy&&!PROXY_AUTH_MODES.includes(proxyAuth))return Promise.reject(Error('Invalid proxy authentication mode'));
    const password=userProxy?String(proxyPassword??this.getProxyPassword?.()??''):'';
    if(userProxy&&(!String(proxyUsername||'').trim()||!password))return Promise.reject(Error('Proxy username and password are required. Run "Whale Bone: Set Proxy Password".'));
    return new Promise((resolve,reject)=>{
      const child=this.spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',this.encoded],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
      let out='',err='',settled=false;const outDecoder=new StringDecoder('utf8'),errDecoder=new StringDecoder('utf8');const timeout=setTimeout(()=>{child.kill();finish(Error('API request timed out'))},(timeoutSeconds+18)*1000);
      function finish(error,data){if(settled)return;settled=true;clearTimeout(timeout);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(data);}
      const abort=()=>{child.kill();finish(Error('Request cancelled'))};signal?.addEventListener('abort',abort,{once:true});
      child.on('error',e=>finish(Error('PowerShell unavailable: '+e.message)));
      child.stdout.on('data',c=>{out+=outDecoder.write(c);if(out.length>12_000_000){child.kill();finish(Error('Response exceeds 12 MB'))}});
      child.stderr.on('data',c=>{err=(err+errDecoder.write(c)).slice(-500)});
      child.on('close',code=>{if(settled)return;out+=outDecoder.end();let obj;try{obj=JSON.parse(out.trim())}catch{return finish(Error('PowerShell returned no valid JSON (exit '+code+'). Check execution policy and proxy settings. '+err.slice(0,120)))}
        if(!obj.ok)return finish(Error(`API HTTP ${obj.status||0}: ${String(obj.error||'Connection failed').slice(0,250)}`));
        let data;try{data=JSON.parse(obj.body)}catch{return finish(Error('API returned non-JSON data'))}
        finish(null,{status:obj.status,proxyUsed:obj.proxyUsed,data});});
      child.stdin.on('error',()=>{});
      child.stdin.end(Buffer.from(JSON.stringify({url,method,apiKey,authMode,proxyUrl:useProxy?proxyUrl:'',proxyEnabled:useProxy,proxyAuth:useProxy?proxyAuth:'none',proxyUsername:userProxy?String(proxyUsername).trim():'',proxyPassword:password,timeoutSeconds,userAgent,body:body?JSON.stringify(body):''}),'utf8'));
    });
  }
}
module.exports={ApiTransport,FuseTransport:ApiTransport,LEGACY_AGENT,validateEndpoint,validateProxy,validateProxyAuth,proxyFields,PROXY_AUTH_MODES};
