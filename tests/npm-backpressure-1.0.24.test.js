'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const N=require('../src/npm-packages');
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wb124-'));
const meta=name=>JSON.stringify({name,'dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name,version:'1.0.0',dist:{tarball:`https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`}}}});
const get=url=>new Promise((resolve,reject)=>{const request=http.get(url,res=>{const b=[];res.on('data',x=>b.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(b).toString()}));res.on('error',reject);});request.on('error',reject);});

test('download-slot queue has a finite deadline and a 503 response, not an indefinite socket wait',async()=>{
 const dir=mk();let relay,trigger;const started=new Promise(resolve=>trigger=resolve);
 try{
  relay=await N.startRelay({cacheDir:dir,maxConcurrent:1,queueWaitMs:50,maxUpstreamAttempts:1,fetchFile:async(url,dest)=>{
   if(url.endsWith('/queue-first')){trigger();await new Promise(r=>setTimeout(r,240));}
   await fsp.writeFile(dest,meta(new URL(url).pathname.slice(1)));
  }});
  const first=get(relay.url+'queue-first');await started;
  const at=Date.now(),second=await get(relay.url+'queue-second');
  assert.equal(second.status,503,second.body);assert(Date.now()-at<180,'queue overflow must fail promptly');
  assert.match(second.body,/busy|queue|retry/i);
  const stat=relay.requestStatus();assert.equal(stat.queueTimeouts,1,JSON.stringify(stat));assert.equal(stat.upstreamFailures,0,JSON.stringify(stat));
  assert.equal((await first).status,200);
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('relay shutdown during a backlog reports cancellation without flooding generic processing errors',async()=>{
 const dir=mk();let relay;const log=[];
 try{
  relay=await N.startRelay({cacheDir:dir,maxConcurrent:1,queueWaitMs:5000,onStatus:s=>log.push(s),fetchFile:async(url,dest,{signal}={})=>new Promise((resolve,reject)=>{
   if(signal?.aborted)return reject(Error('aborted'));
   signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
  })});
  const actions=Array.from({length:20},(_,i)=>get(relay.url+'queued-'+i).catch(()=>null));
  await new Promise(r=>setTimeout(r,80));await relay.close();await Promise.all(actions);
  const errors=log.filter(x=>x.includes('ERROR npm relay could not process the registry response'));
  assert.equal(errors.length,0,'cancellation must not be logged as an unknown processing error');
  assert(relay.requestStatus().cancelledRequests>0,JSON.stringify(relay.requestStatus()));
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('npm uses engine-strict and aligns localhost socket limit with relay concurrency',()=>{
 const args=N.argumentsFor(N.parseCommand('npm install -g openclaw'),'http://127.0.0.1:52000/',{prefix:'/tmp/wb',cache:'/tmp/wbc',emptyConfig:'/tmp/u',globalConfig:'/tmp/g'});
 assert(args.includes('--engine-strict=true'),'unsupported Node runtimes should be rejected');
 assert(args.includes('--ignore-scripts=true'),'lifecycle scripts must remain disabled');
 assert(args.includes('--maxsockets=6'),'npm should not exceed the relay concurrent fetch slot count');
});
