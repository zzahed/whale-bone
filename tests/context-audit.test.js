'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const W=require('../src/workspace'),R=require('../src/redaction'),Selection=require('../src/selection-edit'),Auto=require('../src/autocomplete');
const marker='AN_UNIQUE_CREDENTIAL_VALUE_83621';
async function fixture(fn){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wb-audit-context-'));try{return await fn(root);}finally{await fsp.rm(root,{recursive:true,force:true});}}
test('numbered readLines masks every line of a multiline secret before adding line numbers',()=>fixture(async root=>{
 const input='app:\n  password: |\n    '+marker+'\n    next-line-secret\nother: safe';await fsp.writeFile(path.join(root,'config.yaml'),input);
 const result=W.readLines(root,'config.yaml',1,5);assert.ok(!result.text.includes(marker));assert.ok(!result.text.includes('next-line-secret'));assert.match(result.text,/3:     \[REDACTED\]/);
}));
test('search previews do not disclose multiline secret continuation or diff values',()=>fixture(async root=>{
 await fsp.writeFile(path.join(root,'config.yaml'),'user: x\npassword: |\n  '+marker+'\n\nnext: safe');
 // Search matches redacted text only, so a secret value cannot be confirmed by guessing it.
 const result=W.searchWithCoverage(root,'CREDENTIAL_VALUE');assert.equal(result.matches.length,0);
 const key=W.searchWithCoverage(root,'password');assert.equal(key.matches.length,1);assert.equal(key.matches[0].line,2);assert.ok(!JSON.stringify(key.matches).includes(marker));
}));
test('unified diff YAML block content is redacted without changing diff markers',()=>{
 const input='@@ -1,3 +1,3 @@\n+password: |\n+  '+marker+'\n+  secret2\n+other: value';
 const safe=R.redactText(input);assert.ok(!safe.includes(marker));assert.match(safe,/\+  \[REDACTED\]/);assert.match(safe,/\+other: value/);
});
function editorFor(text,startLine,endLine){const rows=text.split(/\n/);const off=n=>rows.slice(0,n).reduce((total,row)=>total+row.length+1,0);return {selection:{isEmpty:false,start:{line:startLine,character:0},end:{line:endLine,character:rows[endLine].length}},document:{uri:{scheme:'file',fsPath:'/workspace/test.yaml'},version:1,languageId:'yaml',getText(range){return range?text.slice(off(range.start.line)+range.start.character,off(range.end.line)+range.end.character):text;}}};}
test('selected secret continuation is blocked even if opening YAML key is not selected',()=>{
 const editor=editorFor('password: |\n  '+marker+'\nnormal: safe',1,1);const snapshot=Selection.captureSelection(editor,'test.yaml');assert.equal(snapshot.sensitiveSelection,true);
 assert.throws(()=>Selection.selectionMessages(snapshot,'explain','explain'),/credential-like/);
});
test('safe selected code remains usable in files containing secrets elsewhere',()=>{
 const editor=editorFor('password: |\n  '+marker+'\nnormal: safe',2,2);const snapshot=Selection.captureSelection(editor,'test.yaml');assert.equal(snapshot.sensitiveSelection,false);
 assert.ok(Selection.selectionMessages(snapshot,'explain','explain').length);
});
test('autocomplete suppresses completion when secret block starts outside 2.5KB prefix',async()=>{
 const prefix='password: |\n  '+marker+'\n'+'  filler\n'.repeat(650);const doc={version:1,uri:{scheme:'file',toString(){return 'file:///test.yaml';}},languageId:'yaml',getText(){return prefix;},offsetAt(){return prefix.length;}};
 let called=false;
 const engine=new Auto.WhaleBoneAutocomplete({vscode:{InlineCompletionTriggerKind:{Invoke:1}},getSettings:()=>({enabled:true,delayMs:0}),getAuthorization:async()=>{called=true;return {approved:true}}});
 const result=await engine.provideInlineCompletionItems(doc,{line:652,character:0},{triggerKind:1});
 // Text near cursor is still part of the YAML block, not safe context.
 assert.deepEqual(result,[]);assert.equal(called,false);
});
const Requirements=require('../src/requirements');
test('requirements loader refuses protected secret files and symlink targets',()=>fixture(async root=>{
 await fsp.writeFile(path.join(root,'.env'),'SECRET=credential-value');
 await fsp.writeFile(path.join(root,'primary.txt'),'-r .env\n');
 assert.throws(()=>Requirements.parseRequirementsFile(path.join(root,'primary.txt'),root),/primary.txt:1:/);
 await fsp.writeFile(path.join(root,'safe.txt'),'requests==2.32.0\n');
 await fsp.symlink('safe.txt',path.join(root,'linked.txt'));
 assert.throws(()=>Requirements.parseRequirementsFile(path.join(root,'linked.txt'),root),/Symbolic link/);
}));
test('reviewed code cannot add new redaction placeholders even if one exists on disk',()=>fixture(async root=>{
 const file=path.join(root,'a.txt');await fsp.writeFile(file,'[REDACTED]\n');
 assert.throws(()=>W.prepareEdit(root,{path:'a.txt',content:'[REDACTED]\n[REDACTED]\n'}),/redaction placeholder/);
}));
test('safe source continues to receive optional completion suggestions',async()=>{
 const content='def compute_number():\n    return total\n';
 const doc={version:7,uri:{scheme:'file',toString(){return 'file:///safe.py';}},languageId:'python',getText(){return content;},offsetAt(){return content.length;}};
 let called=0;
 const transport={request:async ()=>{called++;return {data:{choices:[{message:{content:'{"type":"completion","text":" + 1"}'}}]}};}};
 const engine=new Auto.WhaleBoneAutocomplete({vscode:{InlineCompletionTriggerKind:{Invoke:1},Range:class{constructor(a,b){this.start=a;this.end=b;}},InlineCompletionItem:class{constructor(text){this.insertText=text;}}},getSettings:()=>({enabled:true,delayMs:0}),getAuthorization:async()=>({approved:true,config:{baseUrl:'https://example.invalid/v1',model:'fake',outputTokens:256,timeoutSeconds:30},key:'placeholder',transport})});
 const result=await engine.provideInlineCompletionItems(doc,{line:2,character:0},{triggerKind:1});
 assert.equal(called,1);assert.equal(result[0].insertText,' + 1');
});
