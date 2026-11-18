'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const Auto=require('../src/autocomplete');

function completionFixture(options={}){
 const text='function calculate() {\n  return 42;\n}\n';
 const doc={version:1,uri:{scheme:'file',fsPath:'/project/demo.js',toString(){return 'file:///project/demo.js';}},languageId:'javascript',getText(){return text;},offsetAt(){return text.length;}};
 let requests=0,valid=true,scope='workspace-A|https://api.example.com/v1';
 const token={isCancellationRequested:false};
 const transport={request:async()=>{requests++;return {data:{choices:[{message:{content:JSON.stringify({type:'completion',text:' + 1'})}}]}};}};
 const engine=new Auto.WhaleBoneAutocomplete({
  vscode:{Range:class{constructor(start,end){this.start=start;this.end=end;}},InlineCompletionItem:class{constructor(text){this.insertText=text;}},InlineCompletionTriggerKind:{Invoke:1}},
  getSettings:()=>({enabled:true,delayMs:0,minGapMs:0}),
  isAllowed:()=>valid,
  getScopeKey:()=>scope,
  isAuthorizationCurrent:()=>valid,
  getAuthorization:async document=>{
   if(options.onAuthorize)await options.onAuthorize({document,token,setValid:v=>{valid=v;},setScope:v=>{scope=v;}});
   return {approved:true,config:{baseUrl:'https://api.example.com/v1',model:'test',outputTokens:256,timeoutSeconds:30},key:'fake',transport};
  }
 });
 return {doc,token,engine,get requests(){return requests;},setValid:v=>{valid=v;},setScope:v=>{scope=v;},run:()=>engine.provideInlineCompletionItems(doc,{line:3,character:0},{triggerKind:1},token)};
}

test('document edit while credentials are retrieved prevents any API autocomplete request',async()=>{
 const f=completionFixture({onAuthorize:async({document})=>{document.version++;}});
 assert.deepEqual(await f.run(),[]);assert.equal(f.requests,0);
});
test('revoked workspace consent during credential retrieval prevents autocomplete transmission',async()=>{
 const f=completionFixture({onAuthorize:async({setValid})=>{setValid(false);}});
 assert.deepEqual(await f.run(),[]);assert.equal(f.requests,0);
});
test('endpoint or workspace change during authorization prevents autocomplete transmission',async()=>{
 const f=completionFixture({onAuthorize:async({setScope})=>{setScope('workspace-B|https://other.example/v1');}});
 assert.deepEqual(await f.run(),[]);assert.equal(f.requests,0);
});
test('cancellation received while retrieving credentials prevents autocomplete transmission',async()=>{
 const f=completionFixture({onAuthorize:async({token})=>{token.isCancellationRequested=true;}});
 assert.deepEqual(await f.run(),[]);assert.equal(f.requests,0);
});
test('cached completions are discarded after workspace authorization is revoked',async()=>{
 const f=completionFixture();assert.equal((await f.run()).length,1);assert.equal(f.requests,1);
 f.setValid(false);
 assert.deepEqual(await f.run(),[]);assert.equal(f.requests,1);
});
test('invalidating autocomplete cancels an in-flight request and its cached suggestions',async()=>{
 let respond;const f=completionFixture();
 const request=f.engine.getAuthorization;f.engine.getAuthorization=async (...args)=>{
  const value=await request(...args);
  value.transport={request:()=>new Promise(resolve=>{respond=resolve;})};return value;
 };
 const pending=f.run();
 for(let i=0;i<30&&!respond;i++)await new Promise(resolve=>setTimeout(resolve,1));
 assert.equal(typeof respond,'function');f.engine.invalidate();
 respond({data:{choices:[{message:{content:JSON.stringify({type:'completion',text:' + 1'})}}]}});
 assert.deepEqual(await pending,[]);
});

async function withView(action){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb112-native-'));
 const ModuleLoad=Module._load;const settings={get:(k,d)=>k==='baseUrl'?'https://api.example.com/v1':d};
 const folders=[{name:'Work',uri:{fsPath:root}}];
 const vscode={
  EventEmitter:class{constructor(){this.event=()=>{};}fire(){}dispose(){}},
  workspace:{workspaceFolders:folders,isTrusted:true,textDocuments:[],getConfiguration(){return settings;},getWorkspaceFolder(uri){return folders.find(x=>uri.fsPath.startsWith(x.uri.fsPath+path.sep));},registerTextDocumentContentProvider:()=>({dispose(){}})},
  window:{createOutputChannel:()=>({appendLine(){},dispose(){}}),createTextEditorDecorationType:()=>({dispose(){}}),visibleTextEditors:[],showWarningMessage:async()=> 'Save and continue'},
  Uri:{file:p=>({fsPath:p,scheme:'file',toString:()=>p})}
 };
 Module._load=function(request,parent,isMain){if(request==='vscode')return vscode;return ModuleLoad.apply(this,arguments);};
 let Extension;try{delete require.cache[require.resolve('../src/extension')];Extension=require('../src/extension');}finally{Module._load=ModuleLoad;}
 const ctx={extensionPath:path.resolve(__dirname,'..'),subscriptions:[],globalState:{get:()=>true,update:async()=>{}},secrets:{get:async()=> 'fake'}};
 const view=new Extension.WhaleBoneView(ctx);view.root=root;view.credential=async()=> 'fake';
 try{return await action({vscode,root,view});}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('native repository chat saves all dirty readable workspace documents before invoking Agent.perform',()=>withView(async({vscode,root,view})=>{
 const Agent=require('../src/agent');const old=Agent.perform;
 let saves=0,performed=0;
 const docs=[];
 for(const name of ['active.py','unattached.py']){
  const file=path.join(root,name);await fs.writeFile(file,'print(123)');
  const doc={uri:vscode.Uri.file(file),isDirty:true,async save(){saves++;this.isDirty=false;return true;}};
  docs.push(doc);vscode.workspace.textDocuments.push(doc);
 }
 vscode.window.activeTextEditor={document:docs[0],selection:{isEmpty:true}};
 try{Agent.perform=async()=>{performed++;assert.equal(docs.some(x=>x.isDirty),false);return {text:'fresh',edits:[]};};
  const out=await view.nativeRepositoryAnswer('review code',[],null);
  assert.equal(out.text,'fresh');assert.equal(performed,1);assert.equal(saves,2);
 }finally{Agent.perform=old;}
}));
test('native repository chat refuses to send when a user declines to save a dirty source',()=>withView(async({vscode,root,view})=>{
 const Agent=require('../src/agent');const old=Agent.perform;let performed=0;
 const file=path.join(root,'draft.py');await fs.writeFile(file,'print(1)');
 const doc={uri:vscode.Uri.file(file),isDirty:true,async save(){throw Error('must never save');}};
 vscode.workspace.textDocuments.push(doc);vscode.window.showWarningMessage=async()=>undefined;
 try{Agent.perform=async()=>{performed++;};
  await assert.rejects(()=>view.nativeRepositoryAnswer('review code',[],null),/Save the file/);
  assert.equal(performed,0);assert.equal(doc.isDirty,true);
 }finally{Agent.perform=old;}
}));
test('native repository chat refuses to send if workspace changes during save approval',()=>withView(async({vscode,root,view})=>{
 const Agent=require('../src/agent');const old=Agent.perform;let performed=0;
 const file=path.join(root,'draft.py');await fs.writeFile(file,'print(1)');
 const doc={uri:vscode.Uri.file(file),isDirty:true,async save(){this.isDirty=false;view.root=undefined;return true;}};
 vscode.workspace.textDocuments.push(doc);
 try{Agent.perform=async()=>{performed++;};
  await assert.rejects(()=>view.nativeRepositoryAnswer('review code',[],null),/workspace|session/i);
  assert.equal(performed,0);
 }finally{Agent.perform=old;}
}));
