'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const N = require('../src/npm-packages');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb119-'));

test('npm local operations refuse a symlinked node_modules before npm ci can erase external data', async () => {
  const d=mk(), root=path.join(d,'workspace'), outside=path.join(d,'external');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'important.txt'),'KEEP');
  fs.writeFileSync(path.join(root,'package.json'), JSON.stringify({name:'fixture',version:'1.0.0'}));
  fs.writeFileSync(path.join(root,'package-lock.json'), JSON.stringify({name:'fixture',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'fixture',version:'1.0.0'}}}));
  fs.symlinkSync(outside,path.join(root,'node_modules'),'dir');
  try {
    assert.throws(()=>N.validateLocalProject(root),/node_modules|symbolic|link|unsafe/i);
    await assert.rejects(()=>N.runNpm({command:'npm ci',relayUrl:'http://127.0.0.1:9/',root,timeoutMs:12000}),/node_modules|symbolic|link|unsafe/i);
    assert.equal(fs.readFileSync(path.join(outside,'important.txt'),'utf8'),'KEEP');
  } finally {fs.rmSync(d,{recursive:true,force:true});}
});

test('npm project workspaces cannot include directories outside the approved root', () => {
  const d=mk(), root=path.join(d,'workspace'), outside=path.join(d,'external'); fs.mkdirSync(root);fs.mkdirSync(outside);
  try {
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',workspaces:['../external']}));
    assert.throws(()=>N.validateLocalProject(root),/workspaces|outside|unsupported/i);
  } finally {fs.rmSync(d,{recursive:true,force:true});}
});

test('npm local operations refuse symlinks under node_modules and not just its root', () => {
 const d=mk(),root=path.join(d,'workspace'),outside=path.join(d,'external');fs.mkdirSync(root);fs.mkdirSync(outside);fs.mkdirSync(path.join(root,'node_modules'));
 fs.symlinkSync(outside,path.join(root,'node_modules','.bin'),'dir');
 try{assert.throws(()=>N.validateLocalProject(root),/node_modules|symbolic|link|unsafe/i);}finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('npm global operations reject a symlinked global prefix', async () => {
 const d=mk(),root=path.join(d,'workspace'),outside=path.join(d,'external'),prefix=path.join(d,'npm-global');fs.mkdirSync(root);fs.mkdirSync(outside);
 fs.symlinkSync(outside,prefix,'dir');
 try{await assert.rejects(()=>N.runNpm({command:'npm install -g yo',relayUrl:'http://127.0.0.1:9/',root,prefix,timeoutMs:2000}),/prefix|symbolic|link|unsafe/i);}finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('npm global prefix allows its own generated bin symlink but rejects an external target', () => {
 const d=mk(),prefix=path.join(d,'prefix');fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});fs.mkdirSync(path.join(prefix,'lib','node_modules','fixture'),{recursive:true});
 const target=path.join(prefix,'lib','node_modules','fixture','bin.js'),bin=path.join(prefix,'bin','fixture');fs.writeFileSync(target,'fixture');
 fs.symlinkSync(target,bin,'file');
 try{ assert.doesNotThrow(()=>N.assertSafeGlobalPrefix(prefix));fs.rmSync(bin);fs.symlinkSync(path.join(d,'outside.js'),bin,'file');assert.throws(()=>N.assertSafeGlobalPrefix(prefix),/symbolic|link|unsafe/i);}
 finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('npm CLI environment removes inherited Node module injection and TLS weakening variables', () => {
 const env=N.npmEnvironment({PATH:'/usr/bin',NODE_PATH:'/tmp/untrusted',NODE_EXTRA_CA_CERTS:'/tmp/untrusted.pem',NODE_TLS_REJECT_UNAUTHORIZED:'0',NODE_OPTIONS:'--require /tmp/untrusted.js',NPM_CONFIG_REGISTRY:'https://evil.invalid/'});
 for(const k of ['NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED','NODE_OPTIONS','NPM_CONFIG_REGISTRY']) assert.equal(Object.hasOwn(env,k),false,k);
 assert.equal(env.NO_PROXY.includes('127.0.0.1'),true);
});

test('npm refuses a symbolic-linked cache path before launching an install', async () => {
 const d=mk(),root=path.join(d,'workspace'),outside=path.join(d,'outside'),cache=path.join(d,'cache');fs.mkdirSync(root);fs.mkdirSync(outside);fs.symlinkSync(outside,cache,'dir');
 try{assert.throws(()=>N.assertSafeDirectoryChain(cache,'cache'),/^Error: Unsafe npm cache: a symbolic link/);await assert.rejects(()=>N.runNpm({command:'npm install -g yo',relayUrl:'http://127.0.0.1:9/',root,cache,timeoutMs:1000}),/^Error: Unsafe npm cache: a symbolic link/);}finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('npm validator rejects dangling symbolic project manifests', () => {
 const d=mk(),root=path.join(d,'workspace');fs.mkdirSync(root);
 try{fs.symlinkSync(path.join(d,'not-created.json'),path.join(root,'package.json'),'file');assert.throws(()=>N.validateLocalProject(root),/symbolic|unsafe/i);}
 finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('npm validator rejects workspace links in lockfiles even without a resolved URL', () => {
 const d=mk();try{fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0'}));
  fs.writeFileSync(path.join(d,'package-lock.json'),JSON.stringify({name:'fixture',lockfileVersion:3,packages:{'':{name:'fixture'},'node_modules/local':{link:true}}}));
  assert.throws(()=>N.validateLocalProject(d),/link dependencies/i);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('npm ci confirmation clearly warns that existing node_modules contents will be removed', async () => {
 const d=mk(),root=path.join(d,'workspace');fs.mkdirSync(root);
 const {NpmPackageUI}=require('../src/npm-package-ui');let prompt='';
 const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:root}}]},window:{createOutputChannel:()=>({dispose(){}}),showWarningMessage:async value=>{prompt=value;return 'Cancel';}}};
 const ui=new NpmPackageUI(vscode,{getRoot:()=>root});ui.locate=async()=>N.findNpmCli({root});
 try{await ui.execute({root,command:N.parseCommand('npm ci')});assert.match(prompt,/node_modules/i);assert.match(prompt,/remov|delet|replac/i);}finally{ui.dispose();fs.rmSync(d,{recursive:true,force:true});}
});
