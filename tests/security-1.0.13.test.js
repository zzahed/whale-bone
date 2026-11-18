'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');const os=require('node:os');
const {redactText}=require('../src/redaction');
const {buildMessages}=require('../src/protocol');
const {PythonPackageUI}=require('../src/python-package-ui');

const cases=[
 ['AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE','AKIAIOSFODNN7EXAMPLE'],
 ['GITHUB_PAT=ghp_123456789012345678901234567890123456','ghp_123456789012345678901234567890123456'],
 ['AccountKey=verylongstoragebase64secret1234==','verylongstoragebase64secret1234=='],
 ['AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=verylongstoragebase64secret1234==;EndpointSuffix=core.windows.net"','verylongstoragebase64secret1234=='],
 ['const options = { aws_access_key_id: "AKIAIOSFODNN7EXAMPLE", github_pat: "ghp_123456789012345678901234567890123456" };','AKIAIOSFODNN7EXAMPLE'],
 ['AccountKey: verylongstoragebase64secret1234==','verylongstoragebase64secret1234=='],
];
for(const [input,secret] of cases)test('1.0.13 redacts enterprise secret: '+input.slice(0,36),()=>{
 const output=redactText(input);assert.ok(!output.includes(secret),`leaked ${secret}`);assert.match(output,/\[REDACTED\]/);
 assert.equal(redactText(output),output);
 const messages=buildMessages([], 'Ask', 'review this', `FILE demo.txt:\n${input}`);
 assert.ok(!JSON.stringify(messages).includes(secret),'secret found in outbound payload');
});

test('1.0.13 retains legitimate non-secret identifiers',()=>{
 for(const text of ['AWS_ACCESS_KEY_ID = None','GITHUB_PAT = os.getenv("GITHUB_PAT")','AccountKey = settings.key','password = args.password','max_tokens = 4096','tokenizer = "demo"'])
  assert.equal(redactText(text),text);
});

test('1.0.13 workspace guard rejects selection change before package operation',async()=>{
 let root='/workspace/A';
 const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:'/workspace/A'}},{uri:{fsPath:'/workspace/B'}}]},window:{createOutputChannel(){return {appendLine(){},dispose(){},show(){}}}}};
 const ui=new PythonPackageUI(vscode,{getRoot:()=>root,getNetwork:()=>({}),extensionRoot:'/unused'});
 assert.equal(typeof ui.assertWorkspace,'function');
 assert.doesNotThrow(()=>ui.assertWorkspace('/workspace/A'));
 root='/workspace/B';
 assert.throws(()=>ui.assertWorkspace('/workspace/A'),/workspace.*changed|changed.*workspace/i);
 ui.dispose();
});

test('1.0.13 native selection guard rejects source, trust, consent, or workspace changes',()=>{
 const {assertNativeSelectionCurrent}=require('../src/native-selection-guard');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb113-native-'));const file=path.join(root,'code.py');fs.writeFileSync(file,'print(1)');const endpoint='https://api.example.com/v1';
 const document={uri:{scheme:'file',fsPath:file},version:7,getText(){return 'print(1)';}};
 const editor={document,selection:{isEmpty:false,start:{line:0,character:0},end:{line:0,character:8}}};
 const vscode={workspace:{isTrusted:true,getWorkspaceFolder:()=>({uri:{fsPath:root}})},window:{activeTextEditor:editor},Range:class{constructor(s,e){this.start=s;this.end=e;}}};
 const provider={root,hasConsent:()=>true};
 const snapshot={version:7,original:'print(1)',range:{start:{line:0,character:0},end:{line:0,character:8}}};
 const validate=()=>assertNativeSelectionCurrent({vscode,provider,editor,snapshot,root,endpoint,getEndpoint:()=>endpoint,token:null});
 assert.doesNotThrow(validate);
 document.version=8;assert.throws(validate,/changed/i);document.version=7;
 provider.hasConsent=()=>false;assert.throws(validate,/consent|authorized/i);provider.hasConsent=()=>true;
 vscode.workspace.isTrusted=false;assert.throws(validate,/trust/i);vscode.workspace.isTrusted=true;
 provider.root='/other';assert.throws(validate,/workspace/i);provider.root=root;
 vscode.window.activeTextEditor=null;assert.throws(validate,/editor|selection/i);vscode.window.activeTextEditor=editor;
 vscode.window.activeTextEditor={document:{uri:{scheme:'whalebone-preview',fsPath:'/preview/outbound.json'}}};
 assert.doesNotThrow(()=>assertNativeSelectionCurrent({vscode,provider,editor,snapshot,root,endpoint,getEndpoint:()=>endpoint,token:null,allowReviewPreview:true}));
 assert.throws(validate,/editor|selection/i);
 vscode.window.activeTextEditor=editor;
 document.getText=()=> 'print(2)';assert.throws(validate,/changed/i);fs.rmSync(root,{recursive:true,force:true});
});

test('1.0.13 reviewed requests remain blocked until approved, and never preview keys',async()=>{
 const {createReviewedTransport}=require('../src/outbound-review');
 let count=0,previewValue='',grant=true;
 const underlying={request:async value=>{count++;return {value};}};
 const wrapper=createReviewedTransport(underlying,{
  enabled:()=>true,assertCurrent:()=>{},
  review:async text=>{previewValue=text;return grant;}
 });
 const request={method:'POST',url:'https://api.example.com/v1/chat/completions',apiKey:'API_KEY_DO_NOT_PREVIEW',body:{model:'test',messages:[{role:'user',content:'Hello'}]}};
 grant=false;await assert.rejects(wrapper.request(request),/declined|cancelled/i);assert.equal(count,0);
 grant=true;const result=await wrapper.request(request);assert.equal(count,1);assert.equal(result.value,request);
 assert.doesNotMatch(previewValue,/API_KEY_DO_NOT_PREVIEW/);
 assert.match(previewValue,/Hello/);
});

test('1.0.13 package selection changing mid-menu never starts an operation',async()=>{
 const rootA='/workspace/A',rootB='/workspace/B';let root=rootA,errors=[],launched=0;
 const P=require('../src/python-packages');const original=P.runProcess;
 const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:rootA}},{uri:{fsPath:rootB}}]},window:{
  createOutputChannel(){return {appendLine(value){errors.push(value)},dispose(){},show(){}};},
  async showQuickPick(items){root=rootB;return items.find(x=>x.action==='venv');},
  async showErrorMessage(x){errors.push(x);}
 }};
 const ui=new PythonPackageUI(vscode,{getRoot:()=>root,getNetwork:()=>({}),extensionRoot:'/unused'});
 try{P.runProcess=async()=>{launched++;};await ui.open();assert.equal(launched,0);assert.match(errors.join(' '),/workspace changed/i);}
 finally{P.runProcess=original;ui.dispose();}
});

test('1.0.13 outbound review blocks transmission when workspace changes during approval',async()=>{
 const {createReviewedTransport}=require('../src/outbound-review');
 let current=true,requests=0;
 const wrapper=createReviewedTransport({request:async()=>{requests++;}},{enabled:()=>true,assertCurrent:()=>{if(!current)throw Error('Workspace changed');},review:async()=>{current=false;return true;}});
 await assert.rejects(wrapper.request({method:'POST',url:'https://test.example/v1/chat/completions',body:{model:'test',messages:[{role:'user',content:'hello'}]}}),/Workspace changed/);
 assert.equal(requests,0);
});

async function nativeView(action){
 const Module=require('node:module'),realLoad=Module._load;
 const workspaceRoot=fs.mkdtempSync(path.join(os.tmpdir(),'wb113-chat-'));
 const file=path.join(workspaceRoot,'example.py');fs.writeFileSync(file,'print(1)');
 const folder={name:'Work',uri:{fsPath:workspaceRoot}};
 const document={uri:{scheme:'file',fsPath:file},version:1,languageId:'python',getText:()=> 'print(1)'};
 const editor={document,selection:{isEmpty:false,start:{line:0,character:0},end:{line:0,character:8}}};
 const vscode={EventEmitter:class{constructor(){this.event=()=>{};}},Range:class{constructor(a,b){this.start=a;this.end=b;}},
  workspace:{workspaceFolders:[folder],isTrusted:true,textDocuments:[],getConfiguration:()=>({get:(k,d)=>k==='baseUrl'?'https://api.example.com/v1':d}),getWorkspaceFolder:()=>folder,registerTextDocumentContentProvider:()=>({dispose(){}})},
  window:{activeTextEditor:editor,createOutputChannel:()=>({appendLine(){},dispose(){}}),createTextEditorDecorationType:()=>({dispose(){}})},Uri:{file:p=>({fsPath:p,scheme:'file'})}};
 Module._load=function(req,parent,isMain){if(req==='vscode')return vscode;return realLoad.apply(this,arguments)};
 let ext;
 try{delete require.cache[require.resolve('../src/extension')];ext=require('../src/extension');}finally{Module._load=realLoad;}
 const ctx={extensionPath:path.resolve(__dirname,'..'),subscriptions:[],globalState:{get:()=>true,update:async()=>{}},secrets:{get:async()=> 'fake'}};
 const view=new ext.WhaleBoneView(ctx);view.root=workspaceRoot;
 try{return await action({vscode,view,editor,document,root:workspaceRoot});}
 finally{fs.rmSync(workspaceRoot,{recursive:true,force:true});}
}

test('1.0.13 actual native /selection request rejects version change before transport',()=>nativeView(async({view,editor,document})=>{
 let requests=0;
 view.transport={request:async()=>{requests++;return {data:{choices:[{message:{content:'{"type":"answer","message":"done"}'}}]}};}};
 view.credential=async()=>{document.version++;return 'fake';};
 await assert.rejects(view.nativeSelectedAnswer({editor,prompt:'Explain'}),/changed/i);
 assert.equal(requests,0);
}));

test('1.0.13 actual native /selection request rejects revoked trust before transport',()=>nativeView(async({view,editor,vscode})=>{
 let requests=0;
 view.transport={request:async()=>{requests++;return {};}};
 view.credential=async()=>{vscode.workspace.isTrusted=false;return 'fake';};
 await assert.rejects(view.nativeSelectedAnswer({editor,prompt:'Explain'}),/trust/i);
 assert.equal(requests,0);
}));

test('1.0.13 turning outbound review on while approval is pending cannot skip review',async()=>{
 const {createReviewedTransport}=require('../src/outbound-review');let active=false,requested=0,checks=0;
 const wrapper=createReviewedTransport({request:async()=>{requested++;return {}; }},{enabled:()=>active,assertCurrent:()=>{if(++checks===2)active=true;},review:async()=>true});
 await assert.rejects(wrapper.request({method:'POST',url:'https://test.example/v1/chat/completions',body:{model:'test',messages:[{role:'user',content:'test'}]}}),/review.*changed|review.*required/i);
 assert.equal(requested,0);
});

test('1.0.13 real workspace reader and outbound protocol remove synthetic cloud credentials',async()=>{
 const W=require('../src/workspace');const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb113-redaction-'));
 const values=['AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE','GITHUB_PAT=ghp_123456789012345678901234567890123456','AccountKey=verylongstoragebase64secret1234=='];
 try{fs.writeFileSync(path.join(root,'settings.txt'),values.join('\n'));
  const read=W.read(root,'settings.txt');const messages=buildMessages([], 'Ask', 'review settings', read.text);
  for(const secret of ['AKIAIOSFODNN7EXAMPLE','ghp_123456789012345678901234567890123456','verylongstoragebase64secret1234==']){
   assert.doesNotMatch(read.text,new RegExp(secret));assert.doesNotMatch(JSON.stringify(messages),new RegExp(secret));
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
