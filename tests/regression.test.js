'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const R=require('../src/redaction'),Req=require('../src/requirements'),P=require('../src/python-packages'),Selection=require('../src/selection-edit');
const secrets=[
 ['Server=db;User Id=sa;Password=Winter2026!;','Server=db;User Id=sa;Password=[REDACTED];'],
 ['db.password=Winter2026!','db.password=[REDACTED]'],
 ['db.password=secret','db.password=[REDACTED]'],
 ['password: secret','password: [REDACTED]'],
 ['export API_TOKEN=abc','export API_TOKEN=[REDACTED]'],
 ['spring.datasource.password=Winter2026!','spring.datasource.password=[REDACTED]'],
 ['$env:API_KEY = "secret-2026"','$env:API_KEY = "[REDACTED]"'],
 ['set PASSWORD=secret123','set PASSWORD=[REDACTED]'],
 ['set "PASSWORD=secret123"','set "PASSWORD=[REDACTED]"'],
 ['export API_TOKEN=secret123','export API_TOKEN=[REDACTED]'],
 ['{ password: "Winter2026!" }','{ password: "[REDACTED]" }'],
 ['{"password":"secret"}','{"password":"[REDACTED]"}'],
 ['{"apiKey":"secret"}','{"apiKey":"[REDACTED]"}'],
 ['connect(password="Winter2026!")','connect(password="[REDACTED]")'],
 ['String password = "Winter2026!";','String password = "[REDACTED]";'],
 ['var apiKey = "Winter2026!";','var apiKey = "[REDACTED]";'],
 ['$password = "secret"','$password = "[REDACTED]"'],
 ['password := "x"','password := "[REDACTED]"'],
 ['password: Winter2026','password: [REDACTED]'],
 ['api_key: abcdef123456XYZ','api_key: [REDACTED]'],
 ['1: Password: SuperSecret99','1: Password: [REDACTED]'],
 ['Authorization: Bearer abcdefghijklmnop','Authorization: Bearer [REDACTED]'],
 ['postgresql://user:pass123@host/db','postgresql://user:[REDACTED]@host/db']
];
for(const [input,expected] of secrets)test('redacts: '+input,()=>assert.equal(R.redactText(input),expected));
const good=[
 'password: string;','password: str','password = None','password = null','password=args.password',
 '{password: pwd}','max_tokens = 4096','tokenizer = "x"','secret_name = "test"',
 'credentials_path = "C:/temp/foo"','TOKEN_URL = "https://example.com/token"',
 'password_hint: string','token_count = 5','password = env.get("PASSWORD")',
 'password = config.secret','const password: string;'
];
for(const input of good)test('preserves: '+input,()=>assert.equal(R.redactText(input),input));
test('idempotent and redactedLines tracks exactly',()=>{const raw=secrets.map(s=>s[0]).join('\n');const once=R.redactText(raw);assert.equal(R.redactText(once),once);assert.equal(R.redactedLines(raw).length,secrets.length);});
test('safe PEP 508 specs',()=>{for(const s of ['requests >= 2.31','pkg[a, b] >= 1.0','python-dateutil==4.0.0; python_version >= "3.9"','numpy; (sys_platform == "win32" and python_version >= "3.13")'])assert.doesNotThrow(()=>Req.validateSpec(s));});
test('requirements rejects pip directives, VCS, URLs and unsupported markers',()=>{for(const s of ['-e .','--extra-index-url https://evil','pkg @ https://evil/a.whl','pkg; evil_marker == "x"','pkg; python_version == 3.13','pkg\n--trusted-host attacker'])assert.throws(()=>Req.validateSpec(s));});
test('requirements parses file with local includes, hashes, markers and extras',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-req-test-'));
 try{
  const digest='a'.repeat(64);
  fs.writeFileSync(path.join(dir,'main.txt'),'requests >= 2.31\n-r base.txt\n');
  fs.writeFileSync(path.join(dir,'base.txt'),'python-dateutil==4.0.0; python_version >= "3.9"\nwhalebone-demo==0.1.0 --hash=sha256:'+digest+'\npkg[a, b]\n');
  const r=Req.parseRequirementsFile(path.join(dir,'main.txt'),dir);
  assert.equal(r.packages.length,4);assert.match(r.text,/--hash=sha256:/);assert.match(r.text,/python_version >= "3.9"/);
  assert.equal(r.files.length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('requirements fails on nested cycles and escaping workspace, with line numbers',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-req-test-'));
 try{
  fs.writeFileSync(path.join(dir,'a.txt'),'-r b.txt\n');fs.writeFileSync(path.join(dir,'b.txt'),'-r a.txt\n');
  assert.throws(()=>Req.parseRequirementsFile(path.join(dir,'a.txt'),dir),/cycle.*a.txt/);
  fs.writeFileSync(path.join(dir,'a.txt'),'requests>=2\n-r ../escape.txt\n');
  assert.throws(()=>Req.parseRequirementsFile(path.join(dir,'a.txt'),dir),/a.txt:2:/);
  fs.writeFileSync(path.join(dir,'a.txt'),'requests>=2\n--extra-index-url https:\/\/evil\n');
  assert.throws(()=>Req.parseRequirementsFile(path.join(dir,'a.txt'),dir),/a.txt:2:/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('pip arguments keep hashes as requirements file and use loopback only',()=>{
 const args=P.pipArgs('install',['requests>=2'],{indexUrl:'http://127.0.0.1:3000/simple/',requirementsFile:path.resolve('verified-req.txt')});
 assert.deepEqual(args.slice(-2),['--requirement',path.resolve('verified-req.txt')]);
 assert.throws(()=>P.pipArgs('install',['requests'],{indexUrl:'https://pypi.org/simple/'}));
});
test('remote artifact allowlist remains strict',()=>{
 assert.equal(P.allowedUpstream('https://pypi.org/simple/numpy/'),'https://pypi.org/simple/numpy/');
 for(const u of ['https://evil.com/simple/x','http://pypi.org/simple/a','https://pypi.org.evil.com/simple/a','https://user:pass@pypi.org/simple/x'])assert.throws(()=>P.allowedUpstream(u));
});

test('inline selection edits refuse literal secrets before API request',()=>{
 const snapshot={cursor:false,original:'password = "secret"',relative:'a.py',language:'python',range:{start:{line:0,character:0},end:{line:0,character:19}}};
 assert.throws(()=>Selection.selectionMessages(snapshot,'increase timeout','edit'),/No source was transmitted/);
 const safe={...snapshot,original:'password=args.password'};
 assert.match(Selection.selectionMessages(safe,'refactor','edit')[1].content,/password=args.password/);
});
test('cursor adjacent context is masked without damaging code references',()=>{
 const snapshot={cursor:true,original:'',adjacent:'password = "secret"\npassword=args.password',relative:'a.py',language:'python',range:{start:{line:0,character:0},end:{line:0,character:0}}};
 const content=Selection.selectionMessages(snapshot,'insert','edit')[1].content;
 assert.match(content,/password = "\[REDACTED\]"/);assert.doesNotMatch(content,/password = "secret"/);assert.match(content,/password=args.password/);
});
