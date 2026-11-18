'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const N=require('../src/npm-packages');
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wb120-relay-'));
const metadata=(name='follow-redirects',tarball)=>JSON.stringify({name,'dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name,version:'1.0.0',dist:{tarball:tarball||`https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`}}}});
const get=url=>new Promise((resolve,reject)=>http.get(url,res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({code:res.statusCode,body:Buffer.concat(chunks).toString()}));res.on('error',reject);}).on('error',reject));

test('transient upstream HTTP 502 retries and recovers the follow-redirects metadata',async()=>{
 const tmp=mk();let relay,attempts=0;const logs=[];
 try{relay=await N.startRelay({cacheDir:tmp,retryDelayMs:1,maxUpstreamAttempts:3,onStatus:s=>logs.push(s),fetchFile:async(url,file)=>{attempts++;if(attempts<3)throw Error('npm registry fetch error: The remote server returned an error: (502) Bad Gateway.');await fsp.writeFile(file,metadata());}});
 const r=await get(relay.url+'follow-redirects');assert.equal(r.code,200,r.body);assert.equal(attempts,3);
 assert.match(logs.join(''),/attempt 1\/3/i);assert.match(logs.join(''),/upstream HTTP 502/i);assert.match(logs.join(''),/retry/i);
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('HTTP 407 is never retried and reports proxy authentication without leaking credentials',async()=>{
 const tmp=mk();let relay,attempts=0;const logs=[];
 try{relay=await N.startRelay({cacheDir:tmp,retryDelayMs:1,onStatus:s=>logs.push(s),fetchFile:async()=>{attempts++;throw Error('The remote server returned an error: (407) Proxy Authentication Required. secret=ghp_1234567890');}});
 const r=await get(relay.url+'follow-redirects');assert.equal(r.code,502);assert.equal(attempts,1);assert.match(logs.join(''),/407|proxy authentication/i);
 assert.doesNotMatch(r.body+logs.join(''),/ghp_1234567890/);assert.match(r.body,/authentication|407/i);
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('real upstream package HTTP 404 is a 404 response and no retry',async()=>{
 const tmp=mk();let relay,attempts=0;
 try{relay=await N.startRelay({cacheDir:tmp,retryDelayMs:1,fetchFile:async()=>{attempts++;throw Error('npm registry fetch error: The remote server returned an error: (404) Not Found.');}});
 const r=await get(relay.url+'missing-pkg');assert.equal(r.code,404);assert.equal(attempts,1);
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('retry exhaustion preserves upstream HTTP status and per-package diagnostics',async()=>{
 const tmp=mk();let relay,attempts=0;const logs=[];
 try{relay=await N.startRelay({cacheDir:tmp,retryDelayMs:1,maxUpstreamAttempts:3,onStatus:s=>logs.push(s),fetchFile:async()=>{attempts++;throw Error('npm registry fetch error: HTTP 503 Service Unavailable');}});
 const r=await get(relay.url+'follow-redirects');assert.equal(r.code,502);assert.equal(attempts,3);assert.match(r.body,/503/);assert.match(logs.join(''),/attempt 3\/3/i);
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('PowerShell fetch failure classifier distinguishes transient, TLS and authentication failures',()=>{
 assert.deepEqual(N.classifyUpstreamFailure(Error('The remote server returned an error: (502) Bad Gateway.')).retryable,true);
 assert.equal(N.classifyUpstreamFailure(Error('The remote server returned an error: (407) Proxy Authentication Required.')).retryable,false);
 assert.equal(N.classifyUpstreamFailure(Error('Could not establish trust relationship for the SSL/TLS secure channel.')).retryable,false);
 assert.equal(N.classifyUpstreamFailure(Error('The operation has timed out.')).retryable,true);
});

test('registry health check fetches metadata and a tarball and verifies declared integrity',async()=>{
 const tmp=mk();let relay;const content=Buffer.from('fake-safe-tarball');const integrity='sha512-'+crypto.createHash('sha512').update(content).digest('base64');
 try{relay=await N.startRelay({cacheDir:tmp,retryDelayMs:1,fetchFile:async(url,file)=>{
  if(url.endsWith('.tgz'))return fsp.writeFile(file,content);
  const x=JSON.parse(metadata());x.versions['1.0.0'].dist.integrity=integrity;
  return fsp.writeFile(file,JSON.stringify(x));
 }});
 const diagnosis=await N.probeRegistry(relay.url,'follow-redirects',{verifyTarball:true});
 assert.equal(diagnosis.name,'follow-redirects');assert.equal(diagnosis.version,'1.0.0');assert.equal(diagnosis.tarballBytes,content.length);assert.equal(diagnosis.integrityVerified,true);
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('registry health check rejects mismatched tarball integrity',async()=>{
 const tmp=mk();let relay;
 try{relay=await N.startRelay({cacheDir:tmp,retryDelayMs:1,fetchFile:async(url,file)=>{
  if(url.endsWith('.tgz'))return fsp.writeFile(file,'bad');
  const x=JSON.parse(metadata());x.versions['1.0.0'].dist.integrity='sha512-'+Buffer.alloc(64,0).toString('base64');
  return fsp.writeFile(file,JSON.stringify(x));
 }});
 await assert.rejects(N.probeRegistry(relay.url,'follow-redirects',{verifyTarball:true}),/integrity/i);
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('npm Settings health check calls a tarball-verifying registry probe and reports result',async()=>{
 const {NpmPackageUI}=require('../src/npm-package-ui');
 const root=mk(),events=[],call=[];
 const originalStart=N.startRelay,originalProbe=N.probeRegistry;
 N.startRelay=async()=>({url:'http://127.0.0.1:12345/',close:async()=>{},requestStatus:()=>({metadata:1,tarballs:1})});
 N.probeRegistry=async(...args)=>{call.push(args);return {name:'follow-redirects',version:'1.0.0',metadataBytes:1000,tarballBytes:200,integrityVerified:true,metadataMs:3,tarballMs:5};};
 const v={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:root}}]},ProgressLocation:{Notification:1},window:{createOutputChannel:()=>({append(s){events.push(s);},appendLine(s){events.push(s);},show(){},dispose(){}}),showWarningMessage:async()=> 'Run npm',showInformationMessage:()=>{},showErrorMessage:()=>{},withProgress:async(options,fn)=>fn({report(){}},{onCancellationRequested:()=>({dispose(){}})})}};
 const ui=new NpmPackageUI(v,{getRoot:()=>root});ui.locate=async()=>({node:process.execPath,cli:'/not-relevant/npm-cli.js'});
 try{await ui.execute({root,diagnostic:'follow-redirects'});
  assert.equal(call.length,1);assert.equal(call[0][1],'follow-redirects');assert.equal(call[0][2].verifyTarball,true);
  assert.match(events.join(''),/tarball|integrity|200 bytes/i);
 }finally{N.startRelay=originalStart;N.probeRegistry=originalProbe;ui.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('registry cache survives relay port changes and refreshes expired metadata',async()=>{
 const tmp=mk();let relay;let fetched=0;
 const fetchFile=async(url,file)=>{fetched++;await fsp.writeFile(file,metadata());};
 try{
  relay=await N.startRelay({cacheDir:tmp,fetchFile});assert.equal((await get(relay.url+'follow-redirects')).code,200);await relay.close();relay=null;
  relay=await N.startRelay({cacheDir:tmp,fetchFile});assert.equal((await get(relay.url+'follow-redirects')).code,200);assert.equal(fetched,1,'successful metadata should be reused across relay sessions');await relay.close();relay=null;
  const cached=path.join(tmp,crypto.createHash('sha256').update('https://registry.npmjs.org/follow-redirects').digest('hex'));
  fs.utimesSync(cached,new Date(0),new Date(0));
  relay=await N.startRelay({cacheDir:tmp,fetchFile});assert.equal((await get(relay.url+'follow-redirects')).code,200);assert.equal(fetched,2,'stale registry metadata must refresh');
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('relay refuses linked/hard-linked cache entries to prevent reading unsafe local files',async()=>{
 const tmp=mk();let relay;const out=path.join(os.tmpdir(),'wb120-out-'+crypto.randomBytes(6).toString('hex'));
 const cached=path.join(tmp,crypto.createHash('sha256').update('https://registry.npmjs.org/follow-redirects').digest('hex'));
 fs.writeFileSync(out,metadata());fs.linkSync(out,cached);
 try{await assert.rejects(N.startRelay({cacheDir:tmp,fetchFile:async()=>{throw Error('No outbound access expected');}}),/Unsafe npm registry cache entry/);
  assert.equal(fs.readFileSync(out,'utf8'),metadata());
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});fs.rmSync(out,{force:true});}
});
