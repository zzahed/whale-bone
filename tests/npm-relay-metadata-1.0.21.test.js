'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const N=require('../src/npm-packages');
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wb121-metadata-'));
const tarball=(version)=>`https://registry.npmjs.org/configstore/-/configstore-${version}.tgz`;
const get=url=>new Promise((resolve,reject)=>http.get(url,res=>{const out=[];res.on('data',b=>out.push(b));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(out).toString()}));res.on('error',reject);}).on('error',reject));
function configstoreFixture(){return {name:'configstore','dist-tags':{latest:'8.0.0',legacy:'0.2.0'},versions:{
 '0.1.0':{name:'configstore',version:'0.1.0',dependencies:{unsafe:'git+https://example.invalid/a.git#abc'},dist:{tarball:tarball('0.1.0')}},
 '0.2.0':{name:'configstore',version:'0.2.0',dependencies:{old:'^1.0.0'},dist:{tarball:'https://external.example.invalid/configstore-0.2.0.tgz'}},
 '8.0.0':{name:'configstore',version:'8.0.0',dependencies:{'write-file-atomic':'^6.0.0'},dist:{tarball:tarball('8.0.0'),integrity:'sha512-test'}}
 }};}

test('historical unsupported registry metadata versions do not cause 502 for safe latest configstore',async()=>{
 const dir=mk();let relay;const messages=[];
 try{
  relay=await N.startRelay({cacheDir:dir,fetchFile:async(url,dest)=>fsp.writeFile(dest,JSON.stringify(configstoreFixture())),onStatus:s=>messages.push(s)});
  const response=await get(relay.url+'configstore');assert.equal(response.status,200,response.text);
  const doc=JSON.parse(response.text);
  assert.deepEqual(Object.keys(doc.versions),['8.0.0']);
  assert.equal(doc['dist-tags'].latest,'8.0.0');assert.equal(doc['dist-tags'].legacy,undefined);
  assert.match(doc.versions['8.0.0'].dist.tarball,/^http:\/\/127\.0\.0\.1:\d+\/files\//);
  assert.equal(doc.versions['8.0.0'].dist.integrity,'sha512-test');
  assert.equal(relay.requestStatus().upstreamFailures,0);
  assert.equal(relay.requestStatus().metadataVersionsRejected,2);
  assert.match(messages.join(''),/excluded 2 incompatible historical/i);
  assert.doesNotMatch(response.text+messages.join(''),/example\.invalid/);
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('metadata with no registry-compatible versions fails with a safe 422 and records diagnostics',async()=>{
 const dir=mk();let relay;const errors=[];
 try{
  relay=await N.startRelay({cacheDir:dir,fetchFile:async(url,dest)=>fsp.writeFile(dest,JSON.stringify({name:'configstore','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{dist:{tarball:'https://external.example.invalid/configstore-1.0.0.tgz'}}}})),onStatus:s=>errors.push(s)});
  const response=await get(relay.url+'configstore');
  assert.equal(response.status,422,response.text);
  assert.match(response.text,/registry-compatible versions/i);
  assert.equal(relay.requestStatus().upstreamFailures,0);
  assert.equal(relay.requestStatus().metadataProcessingFailures,1);
  assert.equal(relay.requestStatus().errors[0].category,'metadata-policy');
  assert.doesNotMatch(response.text+errors.join(''),/external\.example\.invalid/);
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('invalid JSON from the official registry is a classified metadata processing failure',async()=>{
 const dir=mk();let relay;
 try{
  relay=await N.startRelay({cacheDir:dir,fetchFile:async(url,dest)=>fsp.writeFile(dest,'THIS IS NOT JSON')});
  const response=await get(relay.url+'configstore');assert.equal(response.status,502);
  assert.match(response.text,/invalid.*metadata|metadata.*invalid/i);
  assert.equal(relay.requestStatus().metadataProcessingFailures,1);
  assert.equal(relay.requestStatus().errors[0].category,'metadata-format');
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('latest tag referencing excluded version fails closed instead of silently installing older release',async()=>{
 const dir=mk();let relay;
 try{
  const doc=configstoreFixture();doc['dist-tags'].latest='0.2.0';
  relay=await N.startRelay({cacheDir:dir,fetchFile:async(url,dest)=>fsp.writeFile(dest,JSON.stringify(doc))});
  const response=await get(relay.url+'configstore');assert.equal(response.status,422,response.text);
  assert.match(response.text,/latest.*unsupported/i);
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('real npm global installation selects safe current version when historical metadata is disallowed', {timeout:60000},async t=>{
 const cp=require('node:child_process');const crypto=require('node:crypto');
 const tools=N.findNpmCli();if(!tools){t.skip('Node.js/npm CLI not installed on this test host');return;}
 const dir=mk();let relay;
 try{
  const root=path.join(dir,'fixture'),prefix=path.join(dir,'global'),cache=path.join(dir,'npm-cache');
  fs.mkdirSync(path.join(root,'package'),{recursive:true});
  fs.writeFileSync(path.join(root,'package','package.json'),JSON.stringify({name:'wb-configstore',version:'8.0.0'}));
  fs.writeFileSync(path.join(root,'package','index.js'),'module.exports = 8;\n');
  const artifact=path.join(dir,'fixture.tgz');cp.execFileSync('tar',['-czf',artifact,'-C',root,'package']);
  const sha='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(artifact)).digest('base64');
  const latest='https://registry.npmjs.org/wb-configstore/-/wb-configstore-8.0.0.tgz';
  relay=await N.startRelay({cacheDir:path.join(dir,'registry-cache'),fetchFile:async(url,file)=>{
   if(url.endsWith('/wb-configstore'))return fsp.writeFile(file,JSON.stringify({name:'wb-configstore','dist-tags':{latest:'8.0.0'},versions:{
    '0.1.0':{version:'0.1.0',dependencies:{bad:'git://evil.example/repo'},dist:{tarball:'https://registry.npmjs.org/wb-configstore/-/wb-configstore-0.1.0.tgz'}},
    '8.0.0':{name:'wb-configstore',version:'8.0.0',dist:{tarball:latest,integrity:sha}}
   }}));
   if(url===latest)return fsp.copyFile(artifact,file);
   throw Error('Unexpected URL in synthetic registry test');
  }});
  const result=await N.runNpm({root:dir,relayUrl:relay.url,tools,command:N.parseCommand('npm install -g wb-configstore@8.0.0'),prefix,cache,timeoutMs:45000});
  assert.equal(result.code,0);
  assert.equal(relay.requestStatus().metadataVersionsRejected,1);
  assert(fs.existsSync(path.join(prefix,'lib','node_modules','wb-configstore','package.json'))||fs.existsSync(path.join(prefix,'node_modules','wb-configstore','package.json')));
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
