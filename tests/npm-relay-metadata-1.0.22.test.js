'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const N=require('../src/npm-packages');
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wb122-npm-'));
const fetchLocal=url=>new Promise((resolve,reject)=>http.get(url,res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(parts).toString('utf8')}));res.on('error',reject);}).on('error',reject));
function metadataFor(name,versions){const latest=Object.keys(versions).at(-1);return {name,'dist-tags':{latest},versions};}
function versionOf(name,v,{dependencies={},devDependencies={},optionalDependencies={},peerDependencies={},tarball}={}){
 return {name,version:v,dependencies,devDependencies,optionalDependencies,peerDependencies,dist:{tarball:tarball||`https://registry.npmjs.org/${name}/-/${name}-${v}.tgz`}};
}

test('globby: development-only GitHub dependency does not reject installable latest, and is not exposed to npm',async()=>{
 const dir=mk();let relay;
 try{
  const metadata=metadataFor('globby',{
   '1.0.0':versionOf('globby','1.0.0',{dependencies:{evil:'git+ssh://attacker.invalid/repo'}}),
   '16.2.4':versionOf('globby','16.2.4',{dependencies:{'fast-glob':'^3.3.3'},devDependencies:{'@globby/main-branch':'sindresorhus/globby#main'}})
  });
  relay=await N.startRelay({cacheDir:dir,fetchFile:async(url,dest)=>fsp.writeFile(dest,JSON.stringify(metadata))});
  const result=await fetchLocal(relay.url+'globby');assert.equal(result.status,200,result.body);
  const data=JSON.parse(result.body);
  assert.equal(data['dist-tags'].latest,'16.2.4');assert.deepEqual(Object.keys(data.versions),['16.2.4']);
  assert.deepEqual(data.versions['16.2.4'].dependencies,{'fast-glob':'^3.3.3'});
  assert.equal(data.versions['16.2.4'].devDependencies,undefined,'dev-only GitHub sources must not reach downstream clients');
  assert.equal(relay.requestStatus().metadataVersionsRejected,1);
  assert.doesNotMatch(result.body,/attacker\.invalid|sindresorhus\/globby#main/);
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('execa: approved npm-alias and ignored non-install dev references do not cause 422',async()=>{
 const dir=mk();let relay;
 try{
  const data=metadataFor('execa',{'10.2.1':versionOf('execa','10.2.1',{
   dependencies:{'@sindresorhus/merge-streams':'^4.0.0'},
   devDependencies:{'@typescript/native':'npm:typescript@^7.0.2','test-helper':'github:publisher/test-helper'}
  })});
  relay=await N.startRelay({cacheDir:dir,fetchFile:async(url,dest)=>fsp.writeFile(dest,JSON.stringify(data))});
  const reply=await fetchLocal(relay.url+'execa');assert.equal(reply.status,200,reply.body);
  const rewritten=JSON.parse(reply.body);assert.equal(rewritten.versions['10.2.1'].devDependencies,undefined);
  assert.equal(rewritten['dist-tags'].latest,'10.2.1');assert.equal(relay.requestStatus().metadataProcessingFailures,0);
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('registry-only policy still blocks Git/file runtime and peer dependencies',()=>{
 for(const key of ['dependencies','peerDependencies','optionalDependencies']){
  const input=metadataFor('demo',{'2.0.0':versionOf('demo','2.0.0',{[key]:{bad:'git+https://example.invalid/package.git'}})});
  assert.throws(()=>N.rewriteMetadata(Buffer.from(JSON.stringify(input)),'http://127.0.0.1:12345/',new Map()),/registry-compatible/i);
 }
});

test('user workspace Git devDependencies remain rejected because local installs include development dependencies',()=>{
 const dir=mk();
 try{fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'work',version:'1.0.0',devDependencies:{git:'github:publisher/repo'}}));
  assert.throws(()=>N.validateLocalProject(dir),/External or local-file dependency source/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('real npm installs a metadata package with unsupported dev-only spec through the localhost relay', {timeout:60000},async t=>{
 const tools=N.findNpmCli();if(!tools){t.skip('Node.js/npm CLI not present');return;}
 const dir=mk();let relay;
 try{
  const root=path.join(dir,'fixture');fs.mkdirSync(path.join(root,'package'),{recursive:true});
  fs.writeFileSync(path.join(root,'package','package.json'),JSON.stringify({name:'wb-dev-only-regression',version:'1.0.0'}));
  fs.writeFileSync(path.join(root,'package','index.js'),'module.exports = 1;\n');
  const artifact=path.join(dir,'artifact.tgz');cp.execFileSync('tar',['-czf',artifact,'-C',root,'package']);
  const sha='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(artifact)).digest('base64');
  const url='https://registry.npmjs.org/wb-dev-only-regression/-/wb-dev-only-regression-1.0.0.tgz';
  const entry=versionOf('wb-dev-only-regression','1.0.0',{devDependencies:{'@dev/only':'github:publisher/private-repo'}});
  entry.dist.integrity=sha;
  const doc=metadataFor('wb-dev-only-regression',{'1.0.0':entry});
  relay=await N.startRelay({cacheDir:path.join(dir,'registry'),fetchFile:async(remote,dest)=>{
   if(remote.endsWith('/wb-dev-only-regression'))return fsp.writeFile(dest,JSON.stringify(doc));
   if(remote===url)return fsp.copyFile(artifact,dest);
   throw Error('Unexpected upstream endpoint');
  }});
  const prefix=path.join(dir,'global');
  const result=await N.runNpm({root:dir,relayUrl:relay.url,tools,command:N.parseCommand('npm install -g wb-dev-only-regression'),prefix,cache:path.join(dir,'npmcache'),timeoutMs:45000});
  assert.equal(result.code,0,result.output);
  assert(fs.existsSync(path.join(prefix,'lib','node_modules','wb-dev-only-regression','package.json'))||fs.existsSync(path.join(prefix,'node_modules','wb-dev-only-regression','package.json')));
  assert.equal(relay.requestStatus().upstreamFailures,0);
 }finally{await relay?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
