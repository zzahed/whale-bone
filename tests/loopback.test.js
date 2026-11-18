'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const P=require('../src/python-packages');

test('pip subprocess environment restores explicit no-proxy bypass for loopback and removes untrusted proxy settings',()=>{
 const env=P.pipEnvironment({HTTP_PROXY:'http://proxy.example:9090',https_proxy:'http://proxy.example:9090',ALL_PROXY:'http://proxy.example',no_proxy:'example.com',PIP_INDEX_URL:'https://evil.example/simple',PATH:'/bin'});
 assert.equal(env.NO_PROXY,'127.0.0.1,localhost,::1');
 assert.equal(env.no_proxy,env.NO_PROXY);
 assert.equal(env.HTTP_PROXY,undefined);assert.equal(env.https_proxy,undefined);assert.equal(env.ALL_PROXY,undefined);
 assert.equal(env.PIP_INDEX_URL,undefined);assert.equal(env.PATH,'/bin');
});

test('selected Python interpreter can reach local relay without public PyPI', {skip:!process.env.PYTHON_FOR_TESTS},async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wb-loopback-'));
 let relay;
 try{
  relay=await P.startRelay({cacheDir:temp,fetchFile:async()=>{throw Error('External requests are forbidden in loopback test');}});
  await P.probePythonLoopback({interpreter:process.env.PYTHON_FOR_TESTS,root:temp,indexUrl:relay.indexUrl});
  assert.equal(relay.requestStatus().index,0);assert.equal(relay.requestStatus().other,1);
 }finally{await relay?.close();await fs.rm(temp,{recursive:true,force:true});}
});

test('Python preflight refuses non-loopback URLs',async()=>{
 await assert.rejects(()=>P.probePythonLoopback({interpreter:process.env.PYTHON_FOR_TESTS||'/bin/sh',indexUrl:'https://pypi.org/simple/'}),/local Whale Bone/);
});

test('extension manifest keeps explicit startup/chat activation without redundant command/view events',()=>{
 const manifest=require('../package.json');
 assert.equal(manifest.version,'0.0.1');
 assert.deepEqual(manifest.activationEvents,['onChatParticipant:whaleBone.coder','onStartupFinished']);
 assert.ok(manifest.contributes.commands.some(c=>c.command==='whaleBone.pythonPackages'));
 assert.ok(manifest.contributes.views.whaleBone.some(v=>v.id==='whaleBone.chatView'));
});
