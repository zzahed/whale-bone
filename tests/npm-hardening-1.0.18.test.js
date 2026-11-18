'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const N=require('../src/npm-packages');const {NpmPackageUI}=require('../src/npm-package-ui');
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wb118-'));
const clean=p=>fs.rmSync(p,{recursive:true,force:true});

test('project validator rejects hard linked package.json, package-lock.json and .npmrc',()=>{
 const d=mk(),root=path.join(d,'work');fs.mkdirSync(root);
 try{for(const file of ['package.json','package-lock.json','.npmrc']){
  const outside=path.join(d,file);fs.writeFileSync(outside,file==='.npmrc'?'':JSON.stringify({name:'good',version:'1.0.0',packages:{}}));fs.linkSync(outside,path.join(root,file));
  assert.throws(()=>N.validateLocalProject(root),/hard.link|multiple link|unsafe/i,`accepted ${file}`);fs.rmSync(path.join(root,file));fs.rmSync(outside);
 }}finally{clean(d);}
});

test('managed npm rejects previously saved workspace-controlled CLI paths and malformed npm.cmd shims',()=>{
 const d=mk(),root=path.join(d,'work');fs.mkdirSync(root);const node=path.join(d,process.platform==='win32'?'node.exe':'node');fs.copyFileSync(process.execPath,node);fs.writeFileSync(path.join(root,'npm-cli.js'),'console.log("untrusted")');
 try{assert.throws(()=>N.validateTools({node,cli:path.join(root,'npm-cli.js')},root),/workspace/i);
  const other=path.join(d,'npm.cmd');fs.writeFileSync(other,'@echo off');assert.throws(()=>N.validateTools({node,cli:other},root),/npm-cli\.js|npm cli/i);
 }finally{clean(d);}
});

test('UI revalidates saved tools, refuses workspace deletion and cancels active operations',async()=>{
 const d=mk(),root=path.join(d,'work');fs.mkdirSync(root);const node=path.join(d,process.platform==='win32'?'node.exe':'node');fs.copyFileSync(process.execPath,node);fs.writeFileSync(path.join(root,'npm-cli.js'),'');
 let current=root,abortCount=0;const listeners=[];
 const v={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:root}}],onDidChangeWorkspaceFolders(fn){listeners.push(fn);return{dispose(){}}}},window:{createOutputChannel:()=>({dispose(){}})}};
 const originalFind=N.findNpmCli;N.findNpmCli=()=>null;
 const ui=new NpmPackageUI(v,{getRoot:()=>current,globalState:{get:()=>({node,cli:path.join(root,'npm-cli.js')})}});
 try{assert.throws(()=>ui.assertWorkspace(root+'-nonexistent'),/changed/i);
  await assert.rejects(ui.locate(root),/workspace/i);
  ui.active={abort(){abortCount++}};ui.operationRoot=root;current=null;v.workspace.workspaceFolders=[];
  listeners.forEach(fn=>fn({removed:[{uri:{fsPath:root}}],added:[]}));
  assert.equal(abortCount,1);assert.throws(()=>ui.assertWorkspace(root),/workspace.*(closed|changed|removed)/i);
 }finally{N.findNpmCli=originalFind;ui.dispose();clean(d);}
});

test('lockfile rejects unsupported Git, SSH, file URLs and expired localhost relay ports in v1, v2, v3',()=>{
 const d=mk();try{fs.writeFileSync(path.join(d,'package.json'),'{"name":"x","version":"1.0.0"}');
  const bad=['git://example.invalid/repo','ssh://example.invalid/repo','http://127.0.0.1:34567/old/-/x.tgz','git+ssh://example.invalid/repo','file:../pkg.tgz'];
  for(const url of bad){for(const structure of [{lockfileVersion:3,packages:{'node_modules/a':{resolved:url}}},{lockfileVersion:1,dependencies:{a:{version:'1.0.0',resolved:url}}}]){
   fs.writeFileSync(path.join(d,'package-lock.json'),JSON.stringify(structure));assert.throws(()=>N.validateLocalProject(d),/lockfile|source|URL|registry/i,`${url} accepted`);
  }}
 }finally{clean(d);}
});

test('registry metadata rejects dependency graph that invokes non-registry Git URLs',()=>{
 const metadata={name:'fixture',versions:{'1.0.0':{name:'fixture',version:'1.0.0',dependencies:{evil:'git://bad.invalid/evil'},dist:{tarball:'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz'}}}};
 assert.throws(()=>N.rewriteMetadata(Buffer.from(JSON.stringify(metadata)),'http://127.0.0.1:12345/',new Map()),/source|dependency|registry/i);
});

test('npm install uses scripts-disabled compatibility notice for dependencies needing lifecycle hooks',()=>{
 const d=mk();try{fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({name:'x',version:'1.0.0',scripts:{postinstall:'node test.js'}}));
  const messages=N.lifecycleWarnings(d);
  assert.match(messages.join(' '),/postinstall|lifecycle|scripts/i);
  fs.writeFileSync(path.join(d,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/native':{hasInstallScript:true}}}));
  assert.match(N.lifecycleWarnings(d).join(' '),/native|install/i);
 }finally{clean(d);}
});

test('npm-shrinkwrap.json is validated like package-lock.json, including hard links',()=>{
 const d=mk(),root=path.join(d,'workspace');fs.mkdirSync(root);
 try{
  fs.writeFileSync(path.join(root,'npm-shrinkwrap.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/x':{resolved:'ssh://invalid.example/x'}}}));
  assert.throws(()=>N.validateLocalProject(root),/lockfile|source|registry|URL/i);
  fs.rmSync(path.join(root,'npm-shrinkwrap.json'));
  const external=path.join(d,'external.json');fs.writeFileSync(external,'{}');fs.linkSync(external,path.join(root,'npm-shrinkwrap.json'));
  assert.throws(()=>N.validateLocalProject(root),/hard.link|unsafe|multiple link/i);
 }finally{clean(d);}
});

test('override dependency URLs are rejected before npm is invoked',()=>{
 const d=mk();try{
  fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({name:'x',version:'1.0.0',overrides:{'foo':{'bar':'git+ssh://invalid.example/private'}}}));
  assert.throws(()=>N.validateLocalProject(d),/source|registry|external/i);
 }finally{clean(d);}
});

test('local npm operation rejects external hard-linked manifest before executing npm',async()=>{
 const d=mk(),root=path.join(d,'workspace');fs.mkdirSync(root);const ext=path.join(d,'outside.json');const original='{"name":"safe","version":"1.0.0"}';fs.writeFileSync(ext,original);fs.linkSync(ext,path.join(root,'package.json'));
 try{await assert.rejects(N.runNpm({command:N.parseCommand('npm install test'),relayUrl:'http://127.0.0.1:12345/',root}),/hard.link|unsafe|multiple link/i);
  assert.equal(fs.readFileSync(ext,'utf8'),original);
 }finally{clean(d);}
});
