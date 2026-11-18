'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const cp=require('node:child_process'),http=require('node:http'),crypto=require('node:crypto');
const R=require('../src/redaction'),P=require('../src/python-packages');

for(const [input,expected] of [
 ['const cfg = { password: "Winter2026!" };','const cfg = { password: "[REDACTED]" };'],
 ['const cfg={password:"secret", other:1, apiKey:"another"};','const cfg={password:"[REDACTED]", other:1, apiKey:"[REDACTED]"};'],
 ['let connection = { db_pass: "secret" };','let connection = { db_pass: "[REDACTED]" };'],
 ['const o={ "password": "s3cret", "token": "token123" };','const o={ "password": "[REDACTED]", "token": "[REDACTED]" };'],
 ['+DB_PASSWORD=Winter2026!', '+DB_PASSWORD=[REDACTED]'],
 ['-db_pass = "oldpass"', '-db_pass = "[REDACTED]"'],
 ['+const opts={password:"secret"};','+const opts={password:"[REDACTED]"};'],
 ['db_pass = "password123"','db_pass = "[REDACTED]"'],
 ['dbPass = "password123"','dbPass = "[REDACTED]"'],
 ['<add key="Password" value="Winter2026!"/>','<add key="Password" value="[REDACTED]"/>'],
 ["<add value='Winter2026!' key='db_pass' />", "<add value='[REDACTED]' key='db_pass' />"],
 ['<add key="Password" note="x" value="secret" />','<add key="Password" note="x" value="[REDACTED]" />'],
 ['const options = { password: "secret", retries: 3, token: "secret-two" };','const options = { password: "[REDACTED]", retries: 3, token: "[REDACTED]" };'],
 ['const options = { password: "secret", inner: { db_pass: "other" }};','const options = { password: "[REDACTED]", inner: { db_pass: "[REDACTED]" }};'],
 ['const cfg = { password: "secret", password: "different" };','const cfg = { password: "[REDACTED]", password: "[REDACTED]" };']
])test('1.0.9 masks literal: '+input,()=>assert.equal(R.redactText(input),expected));
for(const safe of [
 'password: string;', 'const opts = {password: string};', 'db_pass = None', 'const cfg={password: pwd};',
 'const cfg={password: config.password};', 'password=args.password', 'db_pass = env.get("DB_PASS")',
 'max_tokens = 4096', 'password := envPassword', '<add key="Retries" value="3" />',
 '+++ b/src/config.ts', '--- a/src/config.ts', 'const x = {tokenizer: "GPT", token_count: 12};',
 '<add key="password_hint" value="Avoid reuse" />', 'const config = { password: string };'
])test('1.0.9 preserves legitimate code: '+safe,()=>assert.equal(R.redactText(safe),safe));
test('redaction is idempotent even for nested objects, XML and diff hunk lines',()=>{
 const input='const x={ password: "secret", nested:{db_pass:"secret2"}};\n<add value="foo" key="Password" />\n+DB_PASSWORD=foo';
 assert.equal(R.redactText(R.redactText(input)),R.redactText(input));
 assert.deepEqual(R.redactedLines(input),[1,2,3]);
});
test('managed pip uses null config file and disables explicit proxy for every supported action',()=>{
 const env=P.pipEnvironment({PIP_CONFIG_FILE:'C:/ProgramData/pip/pip.ini',PIP_PROXY:'http://bad:8080',
  PIP_NO_INDEX:'1',PIP_EXTRA_INDEX_URL:'https://bad.example/simple',NO_PROXY:'example.net',HOME:'/tmp'});
 assert.equal(env.PIP_CONFIG_FILE,process.platform==='win32'?'nul':os.devNull);
 assert.equal(env.PIP_PROXY,undefined);assert.equal(env.PIP_NO_INDEX,undefined);
 assert.equal(env.PIP_EXTRA_INDEX_URL,undefined);
 assert.equal(env.NO_PROXY,'127.0.0.1,localhost,::1');assert.equal(env.HOME,'/tmp');
 for(const action of ['install','upgrade','download','uninstall','list','version']){
  const args=P.pipArgs(action,['whalebone-internal-test'],{indexUrl:'http://127.0.0.1:12345/simple/',wheelhouse:'/tmp/wheels'});
  assert.deepEqual(args.slice(0,4),['-m','pip','--isolated','--proxy=']);
  if(action==='install'||action==='upgrade'||action==='download')assert.equal(args.includes('https://pypi.org/simple/'),false);
 }
});

// Real pip execution; all upstream content is synthetic and provided by the
// in-process localhost relay. No corporate network, no system package writes.
const PYTHON=process.env.PYTHON_FOR_TESTS;
test('real pip isolates site/global config: proxy, no-index, extra-index and find-links; system + venv',
 {skip:!PYTHON,timeout:150000},async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wb109-security-'));
 let trap;let oldXdg=process.env.XDG_CONFIG_DIRS;
 try{
  const venvDir=path.join(root,'venv'),venv=path.join(venvDir,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const created=cp.spawnSync(PYTHON,['-m','venv',venvDir],{encoding:'utf8',timeout:70000});
  assert.equal(created.status,0,created.stderr);
  const wheelName='wb_relay_security-1.0.9-py3-none-any.whl';
  const wheel=path.join(root,wheelName);
  const script=String.raw`import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('wb_relay_security/__init__.py','VERSION="1.0.9"\n')
 z.writestr('wb_relay_security-1.0.9.dist-info/METADATA','Metadata-Version: 2.1\nName: wb-relay-security\nVersion: 1.0.9\n')
 z.writestr('wb_relay_security-1.0.9.dist-info/WHEEL','Wheel-Version: 1.0\nGenerator: Whale Bone test\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
 z.writestr('wb_relay_security-1.0.9.dist-info/RECORD','')`;
  const made=cp.spawnSync(PYTHON,['-c',script,wheel],{encoding:'utf8',timeout:30000});assert.equal(made.status,0,made.stderr);
  const sha=crypto.createHash('sha256').update(await fsp.readFile(wheel)).digest('hex');
  const fileUrl='https://files.pythonhosted.org/packages/whalebone-demo/'+wheelName;
  let indexHit=0,wheelHit=0,trapHit=0;
  const fetchFile=async(url,dest)=>{
   if(url==='https://pypi.org/simple/wb-relay-security/'){indexHit++;
    await fsp.writeFile(dest,`<!doctype html><a href="${fileUrl}#sha256=${sha}">${wheelName}</a>`);}
   else if(url===fileUrl){wheelHit++;await fsp.copyFile(wheel,dest);}
   else throw Error('Unexpected upstream URL '+url);
  };
  trap=http.createServer((_req,res)=>{trapHit++;res.writeHead(500);res.end('Unexpected secondary source');});
  await new Promise(resolve=>trap.listen(0,'127.0.0.1',resolve));
  const port=trap.address().port;
  const pipSite=path.join(venvDir,process.platform==='win32'?'pip.ini':'pip.conf');
  const globalRoot=path.join(root,'xdg'),globalConfig=path.join(globalRoot,'pip','pip.conf');
  await fsp.mkdir(path.dirname(globalConfig),{recursive:true});
  await fsp.writeFile(globalConfig,`[global]\nno-index = yes\nextra-index-url = http://127.0.0.1:${port}/simple/\n`);
  if(process.platform!=='win32')process.env.XDG_CONFIG_DIRS=globalRoot;
  const exercises=[
   ['forced proxy',`[global]\nproxy = http://127.0.0.1:9\n`],
   ['no-index',`[global]\nno-index = yes\n`],
   ['secondary index',`[global]\nextra-index-url = http://127.0.0.1:${port}/simple/\n`],
   ['find-links',`[global]\nfind-links = http://127.0.0.1:${port}/wheels/\n`],
   ['combined',`[global]\nproxy = http://127.0.0.1:9\nno-index = yes\nextra-index-url = http://127.0.0.1:${port}/simple/\nfind-links = http://127.0.0.1:${port}/wheels/\n`]
  ];
  for(const [scenario,config] of exercises){
   await fsp.writeFile(pipSite,config);
   const beforeIndex=indexHit, beforeWheel=wheelHit, dest=path.join(root,'download-'+scenario.replace(' ','-'));
   await fsp.mkdir(dest);
   const result=await P.runPip({interpreter:venv,root,action:'download',packages:['wb-relay-security==1.0.9'],wheelhouse:dest,fetchFile});
   assert.equal(result.code,0,scenario);assert.ok(indexHit>beforeIndex,scenario+' index hit');
   assert.ok(wheelHit>beforeWheel,scenario+' wheel hit');assert.equal(trapHit,0,scenario+' secondary index should not be contacted');
   assert.ok(fs.existsSync(path.join(dest,wheelName)),scenario+' wheel downloaded');
  }
  // Test the interpreter outside a venv without ever modifying global packages.
  process.env.PIP_CONFIG_FILE=pipSite;
  const baseDest=path.join(root,'base-download');await fsp.mkdir(baseDest);
  const base=await P.runPip({interpreter:PYTHON,root,action:'download',packages:['wb-relay-security==1.0.9'],wheelhouse:baseDest,fetchFile});
  assert.equal(base.code,0);assert.ok(fs.existsSync(path.join(baseDest,wheelName)));
  assert.equal(trapHit,0);
  assert.ok(indexHit>=6);assert.ok(wheelHit>=6);
  // A venv install must actually install with site pip.conf still hostile.
  await fsp.writeFile(pipSite,exercises[4][1]);
  const installed=await P.runPip({interpreter:venv,root,action:'install',packages:['wb-relay-security==1.0.9'],fetchFile});
  assert.equal(installed.code,0);
  const imported=cp.spawnSync(venv,['-c','import wb_relay_security;print(wb_relay_security.VERSION)'],{encoding:'utf8'});
  assert.equal(imported.status,0,imported.stderr);assert.match(imported.stdout,/1\.0\.9/);
  assert.equal(trapHit,0);
 }finally{
  if(oldXdg===undefined)delete process.env.XDG_CONFIG_DIRS;else process.env.XDG_CONFIG_DIRS=oldXdg;
  delete process.env.PIP_CONFIG_FILE;
  if(trap)await new Promise(resolve=>trap.close(resolve));
  await fsp.rm(root,{recursive:true,force:true});
 }
});
