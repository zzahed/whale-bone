'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Redaction=require('../src/redaction');
const W=require('../src/workspace');
const Protocol=require('../src/protocol');
const Selection=require('../src/selection-edit');
const Agent=require('../src/agent');
const CI=require('../src/ci-checks');
const CheckRunner=require('../scripts/ci-check');
const Python=require('../src/python-packages');
const SECRET='Winter2026!';
for(const [input,output] of [
 ['<add name="MainDb" connectionString="Server=sql;Password=Winter2026!;User ID=sa"/>','<add name="MainDb" connectionString="Server=sql;Password=[REDACTED];User ID=sa"/>'],
 ['password: |\n  Winter2026!\n  abcDEF\nnormal: 4','password: [REDACTED]\n  [REDACTED]\n  [REDACTED]\nnormal: 4'],
 ['- token: >-\n    Winter2026!\n    abcdef\nother: 6','- token: [REDACTED]\n    [REDACTED]\n    [REDACTED]\nother: 6'],
 ['let password: string = "Winter2026!"','let password: string = "[REDACTED]"'],
 ['password: str = "Winter2026!"','password: str = "[REDACTED]"'],
 ['const o = {password:{value:"Winter2026!"}}','const o = {password:{value:"[REDACTED]"}}'],
 ['db.password = "Winter2026!"','db.password = "[REDACTED]"']
])test('security redaction: '+input.slice(0,65),()=>{
 assert.equal(Redaction.redactText(input),output);
 assert.equal(Redaction.redactText(output),output);
});
for(const safe of ['password: str','password: string;','password: str = None', 'password=args.password','const token = process.env.API_TOKEN;','let password: string;', 'max_tokens = 4096'])test('do not corrupt editable code: '+safe,()=>assert.equal(Redaction.redactText(safe),safe));
test('chat history, user requests, diagnostics are sanitized at the outbound message boundary',()=>{
 const messages=Protocol.buildMessages([{role:'user',text:'old message API_KEY=Winter2026!'}],'Ask','password=Winter2026!','diagnostic db_pass = "Winter2026!"');
 const serialized=JSON.stringify(messages);
 assert.ok(!serialized.includes(SECRET));
 assert.match(serialized,/\[REDACTED\]/);
});
test('selected code request redacts typed credential in explain mode and user prompt',()=>{
 const snapshot={original:'password: str = "Winter2026!"',relative:'demo.py',language:'python',cursor:false,range:{start:{line:0,character:0},end:{line:0,character:12}}};
 const messages=Selection.selectionMessages(snapshot,'explain API_KEY=Winter2026!','explain');
 assert.ok(!JSON.stringify(messages).includes(SECRET));
 assert.match(JSON.stringify(messages),/\[REDACTED\]/);
});
test('CI check content and diff are redacted before API request',async()=>{
 let captured;
 const transport={request:async req=>{captured=JSON.stringify(req.body.messages);return {data:{choices:[{message:{content:'{"pass":true,"summary":"ok","findings":[]}'}}]}};}};
 const answer=await CI.evaluate({checks:[{name:'policy.md',content:'policy API_KEY=Winter2026!'}],diff:'+password="Winter2026!"',files:['src/f.js'],transport,config:{baseUrl:'https://example.invalid/v1',model:'test'},apiKey:'placeholder'});
 assert.equal(answer.passed,true);
 assert.ok(!captured.includes(SECRET));
});
test('CI without a diff is a skipped check, not a passing evaluation',async()=>{
 const result=await CI.evaluate({checks:[{name:'policy.md',content:'rules'}],diff:'',files:[],transport:{request:()=>{throw Error('unexpected');}}});
 assert.equal(result.skipped,true);
 assert.equal(result.passed,false);
});
test('agent approved-test output is redacted before subsequent API message',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wb-audit-agent-'));
 let calls=0;
 try{
  await fsp.writeFile(path.join(root,'foo.js'),'console.log(1)');
  const transport={request:async req=>{
   calls++;
   if(calls===2){const body=JSON.stringify(req.body);assert.ok(!body.includes(SECRET),'test stdout leaked');return {data:{choices:[{message:{content:'{"type":"answer","message":"Done"}'}}]}};}
   return {data:{choices:[{message:{content:'{"type":"run","command":"python -m pytest"}'}}]}};
  }};
  const result=await Agent.perform({root,request:'run tests',mode:'Build',config:{baseUrl:'https://example.invalid/v1',model:'fake',outputTokens:200,timeoutSeconds:30},apiKey:'test',transport,runApproved:async()=>({command:'python -m pytest',exitCode:1,stdout:'API_KEY=Winter2026!',stderr:'Password=Winter2026!'}),allowTestTools:true});
  assert.match(result.text,/Done/);assert.equal(calls,2);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
test('already cancelled package operations do not spawn a Python process',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>Python.runProcess('an-invalid-executable.exe',[],{signal:controller.signal}),/Cancelled/);
});
function git(root,args){const out=cp.spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(out.status,0,`${args.join(' ')}: ${out.stderr}`);return out.stdout.trim();}
test('CI refuses a green exit code for excluded or deleted source files',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wb-audit-ci-'));
 try{
  git(root,['init','-q']);git(root,['config','user.name','Whale Bone Tests']);git(root,['config','user.email','test@example.invalid']);
  await fsp.mkdir(path.join(root,'.whalebone','checks'),{recursive:true});
  await fsp.writeFile(path.join(root,'.whalebone','checks','quality.md'),'Check correctness.');
  await fsp.writeFile(path.join(root,'good.js'),'let x = 0;\n');
  await fsp.writeFile(path.join(root,'deleted.js'),'remove this later\n');
  git(root,['add','.']);git(root,['commit','-qm','Base']);const base=git(root,['rev-parse','HEAD']);
  await fsp.writeFile(path.join(root,'good.js'),'let x = 1;\n');
  await fsp.writeFile(path.join(root,'large.js'),'x'.repeat(160000));
  await fsp.rm(path.join(root,'deleted.js'));
  git(root,['add','-A']);git(root,['commit','-qm','Changes']);
  const diff=CI.changedDiff(root,base);assert.equal(diff.incomplete,true);assert.deepEqual(diff.paths,['good.js']);
  const transport={request:async()=>({data:{choices:[{message:{content:'{"pass":true,"summary":"OK","findings":[]}'}}]}})};
  const oldWrite=process.stdout.write;process.stdout.write=()=>true;
  let code;try{code=await CheckRunner.main(['--base',base,'--workspace',root],{WHALEBONE_API_KEY:'test',WHALEBONE_BASE_URL:'https://api.example.com/v1'},transport);}finally{process.stdout.write=oldWrite;}
  assert.equal(code,2,'A partial review must fail closed, even if every AI check passes');
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
