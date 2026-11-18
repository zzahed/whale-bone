'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const P=require('../src/python-packages');

const wheelUrl='https://files.pythonhosted.org/packages/demo/openai-3.48.0-py3-none-any.whl';
const indexUrl='https://pypi.org/simple/openai/';
function get(url){return new Promise((resolve,reject)=>http.get(url,res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));}).on('error',reject));}

function localWheelLink(html){const match=html.match(/href="(\/files\/[^"]+)"/);assert.ok(match,'A wheel link must be present');return match[1];}

test('managed pip allows wheel download longer than the upstream proxy fetch while retaining localhost-only index',()=>{
 const args=P.pipArgs('install',['openai==3.48.0'],{indexUrl:'http://127.0.0.1:12345/simple/'});
 const pos=args.indexOf('--timeout');
 assert.ok(pos>=0);
 assert.ok(Number(args[pos+1])>=600,'pip must not time out at the former 150-second boundary');
 assert.ok(args.includes('http://127.0.0.1:12345/simple/'));
 assert.ok(args.includes('--proxy='));
});

test('relay exposes upstream progress and retries a transient download timeout without changing PowerShell helper',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wb-relay-retry-'));
 const messages=[];let tries=0;let relay;
 try{
  relay=await P.startRelay({cacheDir:temp,onStatus:s=>messages.push(s),fetchFile:async(url,dest)=>{
   if(url===indexUrl)return fs.writeFile(dest,`<a href="${wheelUrl}#sha256=abc">openai-3.48.0-py3-none-any.whl</a>`);
   if(url!==wheelUrl)throw Error('Unexpected upstream request');
   if(++tries===1)throw Error('The operation has timed out');
   await fs.writeFile(dest,'VALID-WHEEL-FOR-RELAY-TEST');
  }});
  const index=await get(relay.indexUrl+'openai/');assert.equal(index.status,200);
  const wheel=await get(relay.url.slice(0,-1)+localWheelLink(index.body));
  assert.equal(wheel.status,200);assert.equal(wheel.body,'VALID-WHEEL-FOR-RELAY-TEST');
  assert.equal(tries,2);
  assert.match(messages.join('\n'),/retry/i);
  assert.match(messages.join('\n'),/openai-3\.48\.0-py3-none-any\.whl/);
  assert.match(messages.join('\n'),/completed/i);
 }finally{await relay?.close();await fs.rm(temp,{force:true,recursive:true});}
});

test('relay fails in bounded time with an actionable upstream diagnostic, not an unbounded local pip hang',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wb-relay-bound-'));
 const messages=[];let relay;
 try{
  relay=await P.startRelay({cacheDir:temp,upstreamFetchTimeoutMs:60,maxUpstreamAttempts:1,onStatus:s=>messages.push(s),fetchFile:async(url,dest,{signal}={})=>{
   if(url===indexUrl)return fs.writeFile(dest,`<a href="${wheelUrl}">openai-3.48.0-py3-none-any.whl</a>`);
   await new Promise((resolve,reject)=>{if(signal?.aborted)return reject(Error('Cancelled'));signal?.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true});});
  }});
  const index=await get(relay.indexUrl+'openai/');assert.equal(index.status,200);
  const wheel=await get(relay.url.slice(0,-1)+localWheelLink(index.body));
  assert.equal(wheel.status,502);
  assert.match(wheel.body,/upstream|timed out|deadline/i);
  assert.match(relay.failureSummary(),/artifact|upstream|deadline/i);
 }finally{await relay?.close();await fs.rm(temp,{force:true,recursive:true});}
});

test('relay never retries HTTP 407 authentication failures',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wb-relay-407-'));
 let relay,tries=0;
 try{
  relay=await P.startRelay({cacheDir:temp,fetchFile:async(url,dest)=>{
   if(url===indexUrl)return fs.writeFile(dest,`<a href="${wheelUrl}">openai-3.48.0-py3-none-any.whl</a>`);
   tries++;throw Error('Proxy authentication HTTP 407');
  }});
  const index=await get(relay.indexUrl+'openai/');assert.equal(index.status,200);
  const wheel=await get(relay.url.slice(0,-1)+localWheelLink(index.body));
  assert.equal(wheel.status,502);assert.equal(tries,1);
 }finally{await relay?.close();await fs.rm(temp,{force:true,recursive:true});}
});

test('cancelling a wheel fetch settles the pending client and relay promptly',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wb-relay-cancel-'));
 const abort=new AbortController();let relay;
 try{
  relay=await P.startRelay({cacheDir:temp,signal:abort.signal,fetchFile:async(url,dest)=>{
   if(url===indexUrl)return fs.writeFile(dest,`<a href="${wheelUrl}">openai-3.48.0-py3-none-any.whl</a>`);
   return new Promise(()=>{}); // Simulate a helper that does not settle after cancellation.
  }});
  const index=await get(relay.indexUrl+'openai/');
  const request=get(relay.url.slice(0,-1)+localWheelLink(index.body)).catch(e=>e);
  await new Promise(resolve=>setTimeout(resolve,20));abort.abort();
  await Promise.race([relay.close(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Relay close hung on cancelled upstream fetch')),1000))]);
  await Promise.race([request,new Promise((_,reject)=>setTimeout(()=>reject(Error('Client request hung after cancellation')),1000))]);
 }finally{await relay?.close();await fs.rm(temp,{force:true,recursive:true});}
});
