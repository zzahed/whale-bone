'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const cp=require('node:child_process');
const Python=require('../src/python-packages');const Tools=require('../src/agent-tools');const Redaction=require('../src/redaction');const W=require('../src/workspace');const CI=require('../src/ci-checks');
async function fixture(callback){const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'wb111-fixture-'));try{return await callback(dir);}finally{await fsp.rm(dir,{recursive:true,force:true});}}
const py=process.env.PYTHON_FOR_TESTS||(()=>{for(const x of ['python3.13','python3','python']){try{const s=cp.spawnSync(x,['-c','import sys;print(sys.executable)'],{encoding:'utf8'});if(s.status===0)return s.stdout.trim();}catch{}}return null;})();
test('Python package manager must not import workspace-controlled pip package', {skip:!py},()=>fixture(async root=>{
 await fsp.mkdir(path.join(root,'pip'));
 const marker=path.join(root,'PIP_ATTACK_EXECUTED');
 await fsp.writeFile(path.join(root,'pip','__main__.py'),`open(${JSON.stringify(marker)},'w').write('bad')\nprint('[]')\n`);
 await fsp.writeFile(path.join(root,'pip','__init__.py'),'');
 await Python.runPip({interpreter:py,root,action:'list'});
 assert.equal(fs.existsSync(marker),false,'workspace pip package should not execute');
}));
test('Python manager must not import workspace-controlled venv module', {skip:!py},()=>fixture(async root=>{
 await fsp.mkdir(path.join(root,'venv'));
 const marker=path.join(root,'VENV_ATTACK_EXECUTED');
 await fsp.writeFile(path.join(root,'venv','__main__.py'),`open(${JSON.stringify(marker)},'w').write('bad')\n`);
 await fsp.writeFile(path.join(root,'venv','__init__.py'),'');
 await Python.runProcess(py,['-m','venv','--help'],{cwd:root,timeoutMs:20000});
 assert.equal(fs.existsSync(marker),false,'workspace venv package should not execute');
}));
test('Python subprocess strips hostile PYTHONPATH, PYTHONHOME, startup and injection variables',()=>{
 const env=Python.pipEnvironment({...process.env,PYTHONPATH:'/workspace',PYTHONHOME:'/bad',PYTHONSTARTUP:'/malicious.py',PYTHONINSPECT:'1',PYTHONWARNINGS:'ignore',PYTHONUSERBASE:'/test'});
 for(const key of ['PYTHONPATH','PYTHONHOME','PYTHONSTARTUP','PYTHONINSPECT','PYTHONWARNINGS','PYTHONUSERBASE'])assert.equal(env[key],undefined,key);
});
test('approved runner must expose resolved executable before asking for consent',async()=>fixture(async root=>{
 let approved=null,executed=false;
 const output=await Tools.runApprovedTest({root,command:'node --test',enabled:true,resolveExe:()=>process.execPath,approve:async(command,exe)=>{approved={command,exe};return false;},executor:()=>{executed=true;throw Error('should not execute');}}).catch(e=>e);
 assert.match(String(output.message),/authorize|declined/i);assert.equal(approved.exe,process.execPath);assert.equal(executed,false);
}));
for(const secret of [
 'secret = "val-12345"','subscription_key = "val-12345"','AZURE_OPENAI_KEY = "val-12345"',
 'PGPASSWORD=val-12345','os.environ["API_KEY"] = "val-12345"',
 'const cfg = { secret: "val-12345" }','const cfg = { db_password: "val-12345", subscription_key: "val-12345" }'
])test('redaction masks common credential form: '+secret,()=>assert.ok(!Redaction.redactText(secret).includes('val-12345')));
test('nonsecret code remains editable',()=>{
 for(const text of ['secret_name = "foo"','password: str','let password: string;','max_tokens = 4096','password=args.password','const token = process.env.API_TOKEN;'])assert.equal(Redaction.redactText(text),text);
});
test('cached wheels do not consume workspace file discovery budget',()=>fixture(async root=>{
 await fsp.mkdir(path.join(root,'.whalebone','wheels'),{recursive:true});
 await fsp.writeFile(path.join(root,'.whalebone','wheels','A.whl'),'wheel');
 await fsp.writeFile(path.join(root,'source.py'),'print(1)');
 const files=W.list(root);assert.ok(files.includes('source.py'));assert.ok(!files.some(f=>f.endsWith('.whl')));
}));
test('Git changed-file detection handles UTF-8 filenames',()=>fixture(async root=>{
 const g=(...args)=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 g('init','-q');g('config','user.email','test@example.invalid');g('config','user.name','Unit');
 await fsp.writeFile(path.join(root,'ملف.py'),'print(1)\n');g('add','.');g('commit','-qm','baseline');
 await fsp.writeFile(path.join(root,'ملف.py'),'print(2)\n');g('add','.');g('commit','-qm','changed');
 const changed=CI.changedDiff(root,'HEAD~1');assert.ok(changed.paths.includes('ملف.py'),JSON.stringify(changed));
}));

function createVSCodeHarness(root){
 const Module=require('node:module'),loads=Module._load;
 const store=new Map([['baseUrl','https://api.example.com/v1']]);const updates=[];
 const settings={get:(k,d)=>store.has(k)?store.get(k):d,update:async(k,v)=>{updates.push([k,v]);if(settings.failAt===k)throw Error('Injected settings write failure');store.set(k,v);}};
 const folders=[{name:'Alpha',uri:{fsPath:root}}];
 const vscode={
  EventEmitter:class{constructor(){this.event=()=>{};}fire(){}dispose(){}},
  ConfigurationTarget:{Global:1},
  workspace:{workspaceFolders:folders,isTrusted:true,textDocuments:[],getWorkspaceFolder(uri){return folders.find(f=>uri.fsPath?.startsWith(f.uri.fsPath+'/'));},getConfiguration(){return settings;},registerTextDocumentContentProvider:()=>({dispose(){}})},
  window:{createOutputChannel:()=>({appendLine(){},dispose(){}}),createTextEditorDecorationType:()=>({dispose(){}}),visibleTextEditors:[],showWarningMessage:async()=>undefined},
  Uri:{file:p=>({fsPath:p,scheme:'file',toString:()=>p})}
 };
 Module._load=function(request,parent,isMain){if(request==='vscode')return vscode;return loads.apply(this,arguments);};
 let Extension;try{delete require.cache[require.resolve('../src/extension')];Extension=require('../src/extension');}finally{Module._load=loads;}
 const ctx={extensionPath:path.resolve(__dirname,'..'),subscriptions:[],globalState:{get:()=>true,update:async()=>{}},secrets:{get:async()=> 'test-key'}};
 const view=new Extension.WhaleBoneView(ctx);view.root=root;
 return {vscode,view,folders,settings,store,updates};
}
test('AI request must not use a newly selected workspace after asynchronous authorization',()=>fixture(async root=>{
 const {view,folders}=createVSCodeHarness(root);
 const beta=await fsp.mkdtemp(path.join(os.tmpdir(),'wb111-beta-'));let called=false;
 const Agent=require('../src/agent'),previous=Agent.perform;
 try{
  folders.push({name:'Beta',uri:{fsPath:beta}});
  view.credential=async()=>{view.root=beta;return 'test-key';};
  Agent.perform=async()=>{called=true;return {text:'bad',edits:[]};};
  await assert.rejects(view.run('review source','Ask'),/workspace changed|session changed|authorization/i);
  assert.equal(called,false,'no AI request may run under another workspace');
 }finally{Agent.perform=previous;await fsp.rm(beta,{recursive:true,force:true});}
}));
test('workspace switch clears visible and model history as one session',()=>fixture(async root=>{
 const {view}=createVSCodeHarness(root);
 view.messages=[{type:'chat',role:'user',text:'prior workspace private text'}];view.history=[{role:'user',text:'older context'}];view.pending=[{path:'old.py'}];view.attached=[{path:'old.py'}];
 const beta=await fsp.mkdtemp(path.join(os.tmpdir(),'wb111-beta-'));
 try{view.changeWorkspace(beta);assert.deepEqual(view.messages,[]);assert.deepEqual(view.history,[]);assert.deepEqual(view.pending,[]);assert.deepEqual(view.attached,[]);assert.equal(view.root,beta);}finally{await fsp.rm(beta,{recursive:true,force:true});}
}));
test('removing authorized workspace cancels active work and clears session',()=>fixture(async root=>{
 const {view}=createVSCodeHarness(root);const controller=new AbortController();view.runController=controller;view.messages=[{type:'chat',text:'sensitive'}];
 view.handleWorkspaceFolders([]);
 assert.equal(controller.signal.aborted,true);assert.deepEqual(view.messages,[]);assert.equal(view.root,undefined);
}));
test('configuration save restores previous values after partial failure',()=>fixture(async root=>{
 const {view,settings,store}=createVSCodeHarness(root);
 store.set('model','old/model');store.set('outputTokens',4096);
 settings.failAt='outputTokens';
 await assert.rejects(view.saveSettings({model:'new/model',outputTokens:8000}),/settings write|settings save|Injected/i);
 assert.equal(store.get('model'),'old/model');assert.equal(store.get('outputTokens'),4096);
}));
test('AI must not read a stale editor buffer when the attached document is dirty',()=>fixture(async root=>{
 const {view,vscode}=createVSCodeHarness(root);await fsp.writeFile(path.join(root,'source.py'),'print("on disk")');
 const doc={uri:vscode.Uri.file(path.join(root,'source.py')),isDirty:true,async save(){this.isDirty=false;return true;}};
 vscode.workspace.textDocuments.push(doc);
 view.attached=[{path:'source.py'}];view.credential=async()=> 'key';
 const Agent=require('../src/agent'),previous=Agent.perform;let readDirty=false;
 try{
  Agent.perform=async()=>{readDirty=doc.isDirty;return {text:'answer',edits:[]};};
  vscode.window.showWarningMessage=async()=> 'Save and continue';
  await view.run('review source','Ask');assert.equal(readDirty,false,'must save or refuse before reading source');
 }finally{Agent.perform=previous;}
}));
test('response from removed workspace cannot enter newly selected workspace history',()=>fixture(async root=>{
 const {view,folders}=createVSCodeHarness(root);const beta=await fsp.mkdtemp(path.join(os.tmpdir(),'wb111-beta-'));
 const Agent=require('../src/agent'),previous=Agent.perform;
 try{
  folders.push({name:'Beta',uri:{fsPath:beta}});view.credential=async()=> 'key';
  Agent.perform=async()=>{view.changeWorkspace(beta);return {text:'OLD_WORKSPACE_RESPONSE',edits:[]};};
  await view.run('inspect','Ask');
  assert.equal(view.root,beta);assert.deepEqual(view.history,[]);
  assert.ok(!JSON.stringify(view.messages).includes('OLD_WORKSPACE_RESPONSE'));
 }finally{Agent.perform=previous;await fsp.rm(beta,{recursive:true,force:true});}
}));
test('dirty open source outside explicit attachment must be saved or excluded from model tools',()=>fixture(async root=>{
 const {view,vscode}=createVSCodeHarness(root);
 await fsp.writeFile(path.join(root,'other.py'),'print(1)');
 const doc={uri:vscode.Uri.file(path.join(root,'other.py')),isDirty:true,async save(){this.isDirty=false;return true;}};
 vscode.workspace.textDocuments.push(doc);view.credential=async()=> 'key';
 const Agent=require('../src/agent'),previous=Agent.perform;let observed;
 try{
  Agent.perform=async()=>{observed=doc.isDirty;return {text:'answer',edits:[]};};
  vscode.window.showWarningMessage=async()=> 'Save and continue';
  await view.run('search all files','Ask');assert.equal(observed,false,'agent could read stale disk content from other.py');
 }finally{Agent.perform=previous;}
}));
test('context budgeting preserves current task while compacting older conversation',()=>{
 const B=require('../src/context-budget');
 const history=Array.from({length:18},(_,i)=>({role:i%2?'assistant':'user',text:'turn-'+i+' '+('x'.repeat(4000))}));
 const compact=B.compactHistory(history,{keepRecent:6});
 assert.ok(compact.length<18);assert.ok(compact.some(x=>String(x.text).includes('Earlier')));
 assert.equal(compact.at(-1).text,history.at(-1).text);
 const budget=B.inputTokenBudget({contextWindowTokens:16384,outputTokens:4096});
 assert.ok(budget<=16384-4096-1024);
});
test('autocomplete skips oversized editors without materializing entire document',async()=>{
 const Auto=require('../src/autocomplete');let readCount=0,authorized=0;
 const document={version:2,uri:{scheme:'file',toString(){return 'file:///large.py';}},lineCount:100000,
  lineAt(){return {range:{end:{line:99999,character:30}}};},offsetAt(){return 1000000;},
  getText(){readCount++;throw Error('should not materialize huge document');}};
 const engine=new Auto.WhaleBoneAutocomplete({vscode:{InlineCompletionTriggerKind:{Invoke:1}},getSettings:()=>({enabled:true,delayMs:0}),getAuthorization:async()=>{authorized++;return {approved:true};}});
 const result=await engine.provideInlineCompletionItems(document,{line:99999,character:2},{triggerKind:1});
 assert.deepEqual(result,[]);assert.equal(readCount,0);assert.equal(authorized,0);
});
test('autocomplete reads only bounded cursor ranges in VS Code documents',()=>{
 const Auto=require('../src/autocomplete');const text='function hello() {\n  return 123;\n}\n';
 class Range{constructor(start,end){this.start=start;this.end=end;}}
 const document={positionAt:(offset)=>({line:0,character:offset}),offsetAt:p=>p.character,
  getText(range){if(!range)throw Error('full document read not expected');return text.slice(range.start.character,range.end.character);}};
 const result=Auto.editorPrefix(document,{line:0,character:20},Range);
 assert.equal(result.prefix,text.slice(0,20));assert.equal(result.suffix,text.slice(20,370));
});
