'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const W=require('../src/workspace');
const Redaction=require('../src/redaction');
const {buildMessages}=require('../src/protocol');

function fixture(){const parent=fs.mkdtempSync(path.join(os.tmpdir(),'whalebone-116-'));const root=path.join(parent,'workspace');fs.mkdirSync(root);return {root,parent,cleanup(){fs.rmSync(parent,{recursive:true,force:true});}};}

test('security: hard links outside a workspace cannot be read, searched, or edited',()=>{
 const x=fixture();try{
  const external=path.join(x.parent,'external.txt');fs.writeFileSync(external,'PRIVATE_OUTSIDE_VALUE');
  fs.linkSync(external,path.join(x.root,'public.txt'));
  assert.throws(()=>W.read(x.root,'public.txt'),/hard.?link|multiple links/i);
  assert.throws(()=>W.readLines(x.root,'public.txt',1,1),/hard.?link|multiple links/i);
  assert.throws(()=>W.prepareEdit(x.root,{path:'public.txt',content:'tamper'}),/hard.?link|multiple links/i);
  const result=W.searchWithCoverage(x.root,'PRIVATE_OUTSIDE_VALUE');
  assert.equal(result.matches.length,0);
  assert.equal(fs.readFileSync(external,'utf8'),'PRIVATE_OUTSIDE_VALUE');
 }finally{x.cleanup();}
});

test('security: hard link swapped in after proposal staging invalidates Apply',()=>{
 const x=fixture();try{
  const dest=path.join(x.root,'target.txt');fs.writeFileSync(dest,'original');
  const edit=W.prepareEdit(x.root,{path:'target.txt',content:'changed'});
  const external=path.join(x.parent,'outside.txt');fs.writeFileSync(external,'original');
  fs.rmSync(dest);fs.linkSync(external,dest);
  assert.throws(()=>W.stillValid(x.root,edit),/hard.?link|multiple links/i);
 }finally{x.cleanup();}
});

test('security: sensitive query parameters in URLs are masked without changing safe parameters',()=>{
 const input='fetch("https://example.invalid/search?api_key=SYNTHETIC123SECRET&limit=25&sig=TESTSIGNATURE456&sort=asc")';
 const safe=Redaction.redactText(input);
 assert.ok(!safe.includes('SYNTHETIC123SECRET'));assert.ok(!safe.includes('TESTSIGNATURE456'));
 assert.match(safe,/limit=25/);assert.match(safe,/sort=asc/);assert.equal(Redaction.redactText(safe),safe);
 const serialized=JSON.stringify(buildMessages([], 'Ask','check this code',input));
 assert.ok(!serialized.includes('SYNTHETIC123SECRET'));
});

test('security: Azure SAS query signatures and standalone known token types are masked',()=>{
 const input='const url = "https://storage.example.invalid/container?sv=2026-11-01&sp=rl&sig=SAS-SYNTHETIC123%3D";\nconst note = "ghp_123456789012345678901234567890123456"';
 const output=Redaction.redactText(input);
 assert.ok(!output.includes('SAS-SYNTHETIC123'));
 assert.ok(!output.includes('ghp_123456789012345678901234567890123456'));
 assert.match(output,/sv=2026-11-01/);assert.match(output,/sp=rl/);
});

test('security: editor selection response is discarded when workspace consent is revoked in flight',async()=>{
 const Module=require('node:module'),originalLoad=Module._load;
 const x=fixture();let revoked=false,requestCount=0,assistantReplies=0;
 const file=path.join(x.root,'code.py');fs.writeFileSync(file,'print(1)');
 const uri={scheme:'file',fsPath:file,toString:()=>file};
 const document={uri,version:1,languageId:'python',getText:()=> 'print(1)'};
 const editor={document,selection:{isEmpty:false,start:{line:0,character:0},end:{line:0,character:8}}};
 const folder={name:'Test',uri:{fsPath:x.root}};
 const vscode={EventEmitter:class{constructor(){this.event=()=>{};}},workspace:{isTrusted:true,workspaceFolders:[folder],getWorkspaceFolder:()=>folder,getConfiguration:()=>({get:(_key,fallback)=>_key==='baseUrl'?'https://api.example.com/v1':fallback}),registerTextDocumentContentProvider:()=>({dispose(){}})},window:{activeTextEditor:editor,createOutputChannel:()=>({appendLine(){},dispose(){}}),showInformationMessage:async()=>{assistantReplies++;}},Uri:{file:p=>({fsPath:p,scheme:'file'})}};
 Module._load=function(spec){if(spec==='vscode')return vscode;return originalLoad.apply(this,arguments)};
 let extension;
 try{delete require.cache[require.resolve('../src/extension')];extension=require('../src/extension');}finally{Module._load=originalLoad;}
 const context={extensionPath:path.resolve(__dirname,'..'),subscriptions:[],globalState:{get:()=>true,update:async()=>{}},secrets:{get:async()=> 'fake'}};
 const view=new extension.WhaleBoneView(context);
 try{
  view.root=x.root;view.hasConsent=()=>!revoked;view.ensureConsent=async()=>true;view.credential=async()=> 'fake';
  view.transport={request:async()=>{requestCount++;revoked=true;return {data:{choices:[{message:{content:JSON.stringify({type:'answer',message:'SENSITIVE_REPLY'})}}]}};}};
  await assert.rejects(view.selectedRequest('Explain','explain',editor),/authorization|consent|revoked/i);
  assert.equal(requestCount,1);assert.equal(view.messages.filter(m=>m.type==='chat'&&m.text==='SENSITIVE_REPLY').length,0);
 }finally{x.cleanup();delete require.cache[require.resolve('../src/extension')];}
});

test('release: offline integrity verifier uses exactly one current payload checksum manifest',()=>{
 const checker=fs.readFileSync(path.join(__dirname,'../scripts/verify-integrity.ps1'),'utf8');
 assert.match(checker,/Get-ChildItem.*WhaleBone-\*-PAYLOAD-SHA256SUMS\.txt/);
 assert.match(checker,/Count\s+-ne\s+1/);
 assert.doesNotMatch(checker,/WhaleBone-1\.0\.14-PAYLOAD/);
});

test('release: README installation identifies the current VSIX instead of an older version',()=>{
 const docs=fs.readFileSync(path.join(__dirname,'../README.md'),'utf8');
 const manifest=require('../package.json');
 assert.match(docs,new RegExp('^# Whale Bone v'+manifest.version.replaceAll('.','\\.'),'m'));
 assert.match(docs,new RegExp('whale-bone-'+manifest.version.replaceAll('.','\\.')+'\\.vsix'));
});
