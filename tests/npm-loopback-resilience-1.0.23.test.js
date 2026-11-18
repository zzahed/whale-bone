'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),cp=require('node:child_process'),crypto=require('node:crypto');
const N=require('../src/npm-packages');
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wb123-loopback-'));
const packument=name=>JSON.stringify({name,'dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name,version:'1.0.0',dist:{tarball:`https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`}}}});
const get=(url,agent)=>new Promise((resolve,reject)=>http.get(url,{agent},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()}));res.on('error',reject);}).on('error',reject));

test('managed npm retries transient localhost ECONNRESET with bounded delay without changing registry or script policy',()=>{
 const args=N.argumentsFor(N.parseCommand('npm install -g demo'),'http://127.0.0.1:53682/',{prefix:'/tmp/test-prefix',cache:'/tmp/test-cache',emptyConfig:'/tmp/user.npmrc',globalConfig:'/tmp/global.npmrc'});
 assert(args.includes('--fetch-retries=2'),'npm needs independent retries for loopback socket resets');
 assert(args.includes('--fetch-retry-mintimeout=1000'));
 assert(args.includes('--fetch-retry-maxtimeout=5000'));
 assert(args.includes('--ignore-scripts=true'));assert(args.includes('--strict-ssl=true'));
 assert(args.includes('--maxsockets=6'),'keep client connections aligned with six relay download slots');
});

test('relay advertises a keep-alive timeout suitable for high-volume npm request reuse',async()=>{
 const dir=mk();let relay;try{
  relay=await N.startRelay({cacheDir:dir,fetchFile:async(url,dest)=>fsp.writeFile(dest,packument('wb123'))});
  const reply=await get(relay.url+'wb123');assert.equal(reply.status,200,reply.body);
  const timeout=Number((reply.headers['keep-alive']||'').match(/timeout=(\d+)/)?.[1]||0);
  assert(timeout>=30,'localhost response must not advertise a five-second keep-alive window');
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('premature npm client disconnect appears in relay diagnostics without treating it as an upstream failure',async()=>{
 const dir=mk();let relay;const logs=[];try{
  relay=await N.startRelay({cacheDir:dir,onStatus:s=>logs.push(s),fetchFile:async(url,dest)=>{await new Promise(r=>setTimeout(r,120));await fsp.writeFile(dest,packument('wb123cancel'));}});
  await new Promise(resolve=>{
   const req=http.get(relay.url+'wb123cancel',res=>res.resume());req.on('error',()=>{});
   req.on('socket',()=>setTimeout(()=>{req.destroy();resolve();},20));
  });
  await new Promise(r=>setTimeout(r,180));
  assert(relay.requestStatus().clientDisconnects>=1,JSON.stringify(relay.requestStatus()));
  assert.equal(relay.requestStatus().upstreamFailures,0);
  assert.match(logs.join(''),/client.*disconnected/i);
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('real npm succeeds when first localhost metadata socket is reset then a retry serves it', {timeout:90000},async t=>{
 const tools=N.findNpmCli();if(!tools){t.skip('Node.js and npm CLI unavailable');return;}
 const dir=mk(),fixture=path.join(dir,'fixture','package');fs.mkdirSync(fixture,{recursive:true});let server,attempts=0;
 try{
  fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'wb123-fixture',version:'1.0.0'}));
  fs.writeFileSync(path.join(fixture,'index.js'),'module.exports = 123;\n');
  const tar=path.join(dir,'artifact.tgz');cp.execFileSync('tar',['-czf',tar,'-C',path.dirname(fixture),'package']);
  const sha='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(tar)).digest('base64');
  const info={name:'wb123-fixture','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name:'wb123-fixture',version:'1.0.0',dist:{tarball:'https://registry.npmjs.org/wb123-fixture/-/wb123-fixture-1.0.0.tgz',integrity:sha}}}};
  server=http.createServer((req,res)=>{
   if(req.url==='/wb123-fixture'){
    attempts++;if(attempts===1){req.socket.destroy();return;}
    return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(info));
   }
   if(req.url==='/wb123-fixture/-/wb123-fixture-1.0.0.tgz'){
    const body=fs.readFileSync(tar);return res.writeHead(200,{'content-type':'application/octet-stream','content-length':body.length}).end(body);
   }
   res.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/';
  const result=await N.runNpm({root:dir,command:N.parseCommand('npm install -g wb123-fixture'),tools,relayUrl:url,prefix:path.join(dir,'prefix'),cache:path.join(dir,'npm-cache'),timeoutMs:55000});
  assert.equal(result.code,0,result.output);assert.equal(attempts,2,'one socket reset followed by a successful retry');
  assert(fs.existsSync(path.join(dir,'prefix','lib','node_modules','wb123-fixture','package.json'))||fs.existsSync(path.join(dir,'prefix','node_modules','wb123-fixture','package.json')));
 }finally{if(server)await new Promise(done=>server.close(done));fs.rmSync(dir,{recursive:true,force:true});}
});

test('high concurrency metadata downloads do not drop localhost connections', {timeout:45000},async()=>{
 const dir=mk();let relay;try{
  relay=await N.startRelay({cacheDir:dir,maxConcurrent:6,fetchFile:async(url,dest)=>{const name=decodeURIComponent(new URL(url).pathname.slice(1));await new Promise(r=>setTimeout(r,Math.random()*15));await fsp.writeFile(dest,packument(name));}});
  const agent=new http.Agent({keepAlive:true,maxSockets:8});
  try{const results=await Promise.all(Array.from({length:260},(_,i)=>get(relay.url+'wb123-'+i,agent)));
   assert.equal(results.filter(x=>x.status===200).length,260);
   assert.equal(relay.requestStatus().clientDisconnects,0);
   assert.equal(relay.requestStatus().upstreamFailures,0);
  }finally{agent.destroy();}
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
