'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http'),cp=require('node:child_process');
const N=require('../src/npm-packages');
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wb-npm-test-'));
test('allow safe global Yeoman command and reject injection and remote sources',()=>{
 assert.deepEqual(N.parseCommand('npm install -g yo generator-office'),{action:'install',global:true,packages:['yo','generator-office']});
 assert.deepEqual(N.parseCommand('npm i -g @microsoft/generator-sharepoint@1.2.3'),{action:'install',global:true,packages:['@microsoft/generator-sharepoint@1.2.3']});
 for(const s of ['npm install -g yo && curl example.com','npm install git+ssh://evil','npm install -g ../foo','npm install -g --registry=https://evil yo','npm run postinstall','npm publish','npm install -g yo;whoami','npm install -g https://evil/x.tgz']) assert.throws(()=>N.parseCommand(s));
});
test('npm spawned environment removes inherited registry proxy and secrets',()=>{
 const env=N.npmEnvironment({PATH:'/usr/bin',NPM_CONFIG_REGISTRY:'https://evil',npm_config_proxy:'http://bad',HTTP_PROXY:'http://evil',HTTPS_PROXY:'http://evil',NODE_OPTIONS:'--require evil',NPM_TOKEN:'abc'});
 for(const k of Object.keys(env))assert(!/^(npm_config_|NPM_TOKEN$|HTTP_PROXY$|HTTPS_PROXY$|NODE_OPTIONS$)/i.test(k));
 assert.match(env.NO_PROXY,/127\.0\.0\.1/);
});
test('package metadata rewrites remote tarballs without dropping integrity',()=>{
 const dist={name:'yo',versions:{'1.0.0':{name:'yo',version:'1.0.0',dist:{tarball:'https://registry.npmjs.org/yo/-/yo-1.0.0.tgz',integrity:'sha512-foobar'}}}};
 const artifacts=new Map();const out=N.rewriteMetadata(Buffer.from(JSON.stringify(dist)),'http://127.0.0.1:1234/',artifacts);
 assert.equal(out.versions['1.0.0'].dist.integrity,'sha512-foobar');assert.match(out.versions['1.0.0'].dist.tarball,/^http:\/\/127\.0\.0\.1:1234\/files\/[a-f0-9]{64}\//);assert.equal(artifacts.size,1);
 assert.throws(()=>N.rewriteMetadata(Buffer.from(JSON.stringify({name:'x',versions:{v:{dist:{tarball:'https://evil.test/attack.tgz'}}}})),'http://127.0.0.1:1234/',new Map()));
});
test('registry supports scoped metadata, remote tarballs, 404 and host restriction',async()=>{
 const tmp=mk();let relay;let paths=[];const content=Buffer.from('TARBALL');try{
 relay=await N.startRelay({cacheDir:tmp,fetchFile:async (url,file)=>{paths.push(url);if(decodeURIComponent(new URL(url).pathname)==='/@scope/item')await fsp.writeFile(file,JSON.stringify({name:'@scope/item',versions:{'1.0.0':{name:'@scope/item',dist:{tarball:'https://registry.npmjs.org/@scope/item/-/item-1.0.0.tgz',integrity:'sha512-abc'}}}}));else if(url.endsWith('.tgz'))await fsp.writeFile(file,content);else throw Error('HTTP 404');}});
 const get=(uri)=>new Promise((resolve,reject)=>http.get(uri,r=>{const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
 const response=await get(relay.url+'@scope%2fitem');assert.equal(response.status,200,response.body.toString()+' PATHS='+JSON.stringify(paths));const doc=JSON.parse(response.body);assert.equal(doc.name,'@scope/item');const tar=await get(doc.versions['1.0.0'].dist.tarball);assert.equal(tar.status,200);assert.deepEqual(tar.body,content);
 assert.equal((await get(relay.url+'bad/other')).status,404);assert.equal(paths.length,2);
 }finally{await relay?.close();fs.rmSync(tmp,{force:true,recursive:true});}
});
test('npm registry install -g works end-to-end using real npm with offline synthetic package', {timeout:90000},async t=>{
 const cli=N.findNpmCli();if(!cli){t.skip('No installed Node/npm CLI');return;}const tmp=mk();let relay;
 try{const prefix=path.join(tmp,'prefix'),cache=path.join(tmp,'cache'),pkg=path.join(tmp,'pkg');fs.mkdirSync(path.join(pkg,'package'),{recursive:true});
 fs.writeFileSync(path.join(pkg,'package','package.json'),JSON.stringify({name:'wb-npm-fixture',version:'1.0.0',bin:{'wb-npm-fixture':'bin.js'}}));fs.writeFileSync(path.join(pkg,'package','bin.js'),'#!/usr/bin/env node\nconsole.log("WHALERELAY")\n');
 const tgz=path.join(tmp,'fixture.tgz');cp.execFileSync('tar',['-czf',tgz,'-C',pkg,'package']);const bytes=fs.readFileSync(tgz);const hash='sha512-'+crypto.createHash('sha512').update(bytes).digest('base64');
 relay=await N.startRelay({cacheDir:path.join(tmp,'relay'),fetchFile:async(url,file)=>{
  if(url.endsWith('/wb-npm-fixture'))await fsp.writeFile(file,JSON.stringify({name:'wb-npm-fixture','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name:'wb-npm-fixture',version:'1.0.0',dist:{tarball:'https://registry.npmjs.org/wb-npm-fixture/-/wb-npm-fixture-1.0.0.tgz',integrity:hash}}}}));
  else if(url.endsWith('.tgz'))await fsp.copyFile(tgz,file);else throw Error('404');}});
 const res=await N.runNpm({command:{action:'install',global:true,packages:['wb-npm-fixture']},relayUrl:relay.url,tools:cli,prefix,cache,root:tmp,timeoutMs:60000});
 assert.equal(res.code,0);assert(fs.existsSync(path.join(prefix,'lib','node_modules','wb-npm-fixture','package.json'))||fs.existsSync(path.join(prefix,'node_modules','wb-npm-fixture','package.json')));
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
test('workspace npm overrides and non-registry lockfile dependencies fail closed',()=>{
 const root=mk();try{
 fs.writeFileSync(path.join(root,'.npmrc'),'@scope:registry=https://unapproved.invalid/\n');
 assert.throws(()=>N.validateLocalProject(root),/overrides managed registry/);fs.rmSync(path.join(root,'.npmrc'));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({dependencies:{foo:'git+ssh://repo.invalid/repo.git'}}));
 assert.throws(()=>N.validateLocalProject(root),/External or local-file/);
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'local-test',version:'1.0.0'}));
 fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({packages:{'node_modules/foo':{resolved:'https://unapproved.invalid/file.tgz'}}}));
 assert.throws(()=>N.validateLocalProject(root),/non-official registry URL/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('npm install then ci survives registry port changes with package-lock', {timeout:60000},async t=>{
 const tools=N.findNpmCli();if(!tools){t.skip('Node/npm unavailable');return;}
 const tmp=mk();let relay;
 try{
  const root=path.join(tmp,'workspace'),fixture=path.join(tmp,'fixture','package');fs.mkdirSync(root,{recursive:true});fs.mkdirSync(fixture,{recursive:true});
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'consumer',version:'1.0.0',private:true,dependencies:{'wb-npm-fixture':'1.0.0'}}));
  fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'wb-npm-fixture',version:'1.0.0'}));fs.writeFileSync(path.join(fixture,'index.js'),'module.exports=123;\n');
  const tar=path.join(tmp,'fixture.tgz');cp.execFileSync('tar',['-czf',tar,'-C',path.dirname(fixture),'package']);
  const integ='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(tar)).digest('base64');
  const fetchFile=async(url,file)=>{
   if(url.endsWith('/wb-npm-fixture'))await fsp.writeFile(file,JSON.stringify({name:'wb-npm-fixture','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name:'wb-npm-fixture',version:'1.0.0',dist:{tarball:'https://registry.npmjs.org/wb-npm-fixture/-/wb-npm-fixture-1.0.0.tgz',integrity:integ}}}}));
   else if(url.endsWith('.tgz'))await fsp.copyFile(tar,file);else throw Error('404');
  };
  const options={tools,root,cache:path.join(tmp,'cache'),prefix:path.join(tmp,'prefix'),timeoutMs:30000};
  relay=await N.startRelay({cacheDir:path.join(tmp,'r1'),fetchFile});await N.runNpm({...options,command:N.parseCommand('npm install wb-npm-fixture'),relayUrl:relay.url});
  assert(fs.existsSync(path.join(root,'package-lock.json')));await relay.restoreLockfile(root);assert.match(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'),/https:\/\/registry\.npmjs\.org/);await relay.close();relay=null;
  fs.rmSync(path.join(root,'node_modules'),{recursive:true,force:true});
  relay=await N.startRelay({cacheDir:path.join(tmp,'r2'),fetchFile});await N.runNpm({...options,command:N.parseCommand('npm ci'),relayUrl:relay.url});
  assert(fs.existsSync(path.join(root,'node_modules','wb-npm-fixture','package.json')));
 }finally{await relay?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
