'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');

test('1.0.14 reviewed diff closing targets the exact proposal and opens saved source',async()=>{
 const {revealAppliedFile}=require('../src/review-editor');
 const original={toString:()=> 'file:///workspace/app.py'};
 const proposed={toString:()=> 'whalebone-preview:/proposal-123/app.py'};
 const other={toString:()=> 'whalebone-preview:/some-other/app.py'};
 const exact={input:{original,modified:proposed},label:'Whale Bone Review'};
 const unrelated={input:{original,modified:other},label:'Whale Bone Review other'};
 const closed=[];const shown=[];
 const vscode={window:{tabGroups:{all:[{tabs:[unrelated,exact]}],async close(tab){closed.push(tab);return true;}},async showTextDocument(doc,options){shown.push({doc,options});}},ViewColumn:{Active:-1}};
 const doc={uri:original};
 await revealAppliedFile(vscode,doc,{original,proposed});
 assert.deepEqual(closed,[exact]);assert.equal(shown.length,1);assert.equal(shown[0].doc,doc);
 assert.equal(shown[0].options.preview,false);assert.equal(shown[0].options.preserveFocus,false);
});

test('1.0.14 closing a stale diff never prevents reopening a saved target',async()=>{
 const {revealAppliedFile}=require('../src/review-editor');let shown=0;
 const original={toString:()=> 'file:///workspace/app.py'};const proposed={toString:()=> 'whalebone-preview:/123/app.py'};
 const vscode={window:{tabGroups:{all:[{tabs:[{input:{original,modified:proposed}}]}],async close(){throw Error('already closed');}},async showTextDocument(){shown++;}},ViewColumn:{Active:-1}};
 await revealAppliedFile(vscode,{uri:original},{original,proposed});assert.equal(shown,1);
});

test('1.0.14 larger context and output caps are validated, with safe dynamic request sizing',()=>{
 const M=require('../src/model-limits');const B=require('../src/context-budget');
 assert.equal(M.MAX_CONTEXT_TOKENS>=1048576,true);
 assert.equal(M.MAX_OUTPUT_TOKENS>=131072,true);
 assert.doesNotThrow(()=>M.validateLimits({contextWindowTokens:1048576,outputTokens:131072}));
 const settings={contextWindowTokens:131072,outputTokens:131072};
 assert.ok(B.inputTokenBudget(settings)>120000);
 const small=[{role:'user',content:'a'.repeat(5000)}];
 const large=[{role:'user',content:'a'.repeat(100000)}];
 assert.ok(B.effectiveMaxOutput(settings,small)<=131072);
 assert.ok(B.effectiveMaxOutput(settings,large)<B.effectiveMaxOutput(settings,small));
 assert.ok(B.effectiveMaxOutput(settings,small)>=32768);
});

test('1.0.14 default model maximum is bounded by real model architecture',()=>{
 const M=require('../src/model-limits');
 const max=M.selectModelMaximum('openai/gpt-oss-120b');
 assert.equal(max.contextWindowTokens,131072);
 assert.equal(max.outputTokens,131072);
 assert.equal(M.selectModelMaximum('unknown/unlisted'),null);
});

test('1.0.14 sidebar separates files, tools and settings; pip only appears in Settings',()=>{
 const ext=fs.readFileSync(path.join(root,'src','extension.js'),'utf8');
 const fileSection=ext.match(/<section id="files"[\s\S]*?<\/section>/)?.[0];
 const toolsSection=ext.match(/<section id="tools"[\s\S]*?<\/section>/)?.[0];
 const settings=ext.match(/<section id="settings"[\s\S]*?<\/section>/)?.[0];
 assert.ok(fileSection&&toolsSection&&settings);
 assert.doesNotMatch(fileSection,/id="packages"|id="toggleAutocomplete"|id="generateTests"|id="inlineEditButton"/);
 assert.match(toolsSection,/id="generateTests"/);
 assert.match(settings,/id="packagesSettings"/);
 assert.doesNotMatch(ext,/id="packages"/);
 assert.match(ext,/id="maximizeLimits"/);
 const view=fs.readFileSync(path.join(root,'media','view.js'),'utf8');
 assert.match(view,/['"]tools['"]/);
 assert.match(view,/maximizeLimits/);
});


test('1.0.14 model metadata may advertise a smaller maximum output',()=>{
 const M=require('../src/model-limits');
 const caps=M.selectModelMaximum('some/model',{id:'some/model',context_length:131072,max_output_tokens:4096});
 assert.deepEqual(caps,{contextWindowTokens:131072,outputTokens:4096});
});

test('1.0.14 honors user settings in actual agent completion max_tokens',async()=>{
 const Agent=require('../src/agent');
 const config={baseUrl:'https://example.invalid/v1',model:'example/model',contextWindowTokens:131072,outputTokens:131072,timeoutSeconds:60};
 let observed;const transport={request:async input=>{observed=input.body;return {data:{choices:[{message:{content:'{"type":"answer","message":"ok"}'}}]}};}};
 const result=await Agent.perform({root:null,request:'hello',mode:'Ask',config,apiKey:'fake',transport});
 assert.equal(result.text,'ok');assert.ok(observed.max_tokens>16000);assert.ok(observed.max_tokens<131072);
});

test('1.0.14 actual Apply operation persists content, closes only its review diff and opens final file',async()=>{
 const os=require('node:os');const Module=require('node:module'),W=require('../src/workspace');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wb114-apply-'));const file=path.join(tmp,'final.py');fs.writeFileSync(file,'print(1)\n');
 const uri={scheme:'file',fsPath:file,toString:()=>`file://${file}`};
 const unrelated={scheme:'whalebone-preview',toString:()=> 'whalebone-preview:/unrelated.py'};
 const proposed={scheme:'whalebone-preview',toString:()=> 'whalebone-preview:/review.py'};
 const exactTab={input:{original:uri,modified:proposed}};
 const otherTab={input:{original:uri,modified:unrelated}};
 const closed=[],opened=[];
 const document={uri,lineCount:2,isDirty:false,lineAt(i){return {range:{end:{line:i,character:0}}}},async save(){return true;}};
 const vscode={
  EventEmitter:class{constructor(){this.event=()=>{}}},
  Position:class{constructor(line,character){this.line=line;this.character=character}},
  Range:class{constructor(start,end){this.start=start;this.end=end}},
  WorkspaceEdit:class{constructor(){this.changes=[]}replace(uri,_range,text){this.changes.push({uri,text})}},
  ViewColumn:{Active:-1},Uri:{file:()=>uri},
  workspace:{workspaceFolders:[{name:'Project',uri:{fsPath:tmp}}],isTrusted:true,registerTextDocumentContentProvider:()=>({dispose(){}}),async openTextDocument(){return document;},async applyEdit(edit){for(const change of edit.changes)fs.writeFileSync(file,change.text);return true;},getConfiguration(){return {get(_key,fallback){return fallback}}}},
  window:{createOutputChannel:()=>({appendLine(){},dispose(){}}),async showWarningMessage(){return 'Apply change';},async showTextDocument(doc,opts){opened.push({doc,opts})},tabGroups:{all:[{tabs:[otherTab,exactTab]}],async close(tab){closed.push(tab);return true;}}}
 };
 const originalLoad=Module._load;let ext;
 try{Module._load=function(request){if(request==='vscode')return vscode;return originalLoad.apply(this,arguments)};delete require.cache[require.resolve('../src/extension')];ext=require('../src/extension');}finally{Module._load=originalLoad;}
 const view=new ext.WhaleBoneView({extensionPath:root,subscriptions:[],globalState:{get:()=>true},secrets:{get:async()=>null}});view.root=tmp;
 const edit=W.prepareEdit(tmp,{path:'final.py',content:'print(2)\n'});edit.previewed=true;edit.reviewUris={original:uri,proposed};view.pending=[edit];
 try{
  await view.apply(edit.id);
  assert.equal(fs.readFileSync(file,'utf8'),'print(2)\n');assert.deepEqual(closed,[exactTab]);
  assert.equal(opened.length,1);assert.equal(opened[0].doc,document);assert.equal(opened[0].opts.preview,false);
  assert.equal(view.lastApplied.path,'final.py');assert.equal(view.pending.length,0);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('1.0.14 large generated answers are not limited to the earlier 300k-character ceiling',()=>{
 const {parseAction}=require('../src/protocol');
 const message='x'.repeat(710000);
 assert.equal(parseAction(JSON.stringify({type:'answer',message})).message.length,message.length);
});
