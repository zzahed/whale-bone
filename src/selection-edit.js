'use strict';
const {getContent}=require('./protocol');
const {proxyFields}=require('./transport');
const {redactContext}=require('./workspace');
const {redactedLines}=require('./redaction');
const cp1252={0x20ac:0x80,0x201a:0x82,0x0192:0x83,0x201e:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02c6:0x88,0x2030:0x89,0x0160:0x8a,0x2039:0x8b,0x0152:0x8c,0x017d:0x8e,0x2018:0x91,0x2019:0x92,0x201c:0x93,0x201d:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02dc:0x98,0x2122:0x99,0x0161:0x9a,0x203a:0x9b,0x0153:0x9c,0x017e:0x9e,0x0178:0x9f};
const toByte=ch=>{const n=ch.codePointAt(0);return n<=255?n:cp1252[n];};
/** Repair only plausible, reversible UTF-8 text misdecoded as Latin-1/CP1252.
 * Never transcode the entire message: it can also contain correctly decoded Arabic. */
function repairMojibake(value){const s=String(value);
 // A lone two-byte sequence such as Ã© is ambiguous: it might be intentional test data.
 // Only repair two-byte sequences when the message contains stronger corroborating corruption.
 const strong=/â[\u0080-\u00BF]{2}|[ÃÂØÙ][\u0080-\u00BF][\s\S]*[ÃÂØÙ][\u0080-\u00BF]/.test(s);
 let out='';for(let i=0;i<s.length;){const ch=s[i];const first=toByte(ch);const length=first>=0xc2&&first<=0xdf?(strong?2:0):first>=0xe0&&first<=0xef?3:first>=0xf0&&first<=0xf4?4:0;let decoded=null;
  if(length&&i+length<=s.length){const bytes=[];for(let j=0;j<length;j++){const b=toByte(s[i+j]);if(b===undefined){bytes.length=0;break;}bytes.push(b);}if(bytes.length===length&&bytes.slice(1).every(x=>x>=0x80&&x<=0xbf)){
    try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(bytes));}catch{}
  }}
  if(decoded){out+=decoded;i+=length;}else{out+=ch;i++;}
 }return out;}
function captureSelection(editor,relative,{allowCursor=false}={}){const selection=editor?.selection;const doc=editor?.document;
 if(!doc||!selection||typeof doc.getText!=='function'||(selection.isEmpty&&!allowCursor))throw Error('Select the exact code you want Whale Bone to edit or explain.');
 const cursor=!!selection.isEmpty;
 const original=cursor?'':doc.getText(selection);
 if((!cursor&&!original)||original.length>18000)throw Error('Select between 1 and 18,000 characters of code.');
 // An insertion needs at most a few neighboring lines, never the whole editor buffer.
 const full=String(doc.getText()),lines=cursor?redactContext(full).split(/\r?\n/):[];
 const startLine=selection.start.line+1,endLine=selection.end.line+1;
 const sensitiveSelection=!cursor&&redactedLines(full).some(n=>n>=startLine&&n<=endLine);
 const line=selection.start.line;
 const adjacent=cursor?lines.slice(Math.max(0,line-2),Math.min(lines.length,line+3)).join('\n').slice(0,1000):'';
 return {uri:doc.uri,version:doc.version,relative,language:doc.languageId||'plaintext',cursor,adjacent,sensitiveSelection,range:{start:{line:selection.start.line,character:selection.start.character},end:{line:selection.end.line,character:selection.end.character}},original};
}
function selectionMessages(snapshot,prompt,mode='edit'){
 if(snapshot.sensitiveSelection)throw Error('Selected source overlaps a credential-like value. Select other code or replace credentials locally before sending it to the AI endpoint. No source was transmitted.');
 const filtered=redactContext(snapshot.original);
 if(mode==='edit'&&filtered!==snapshot.original)throw Error('Selected source contains a credential-like value. Remove or replace the credential locally before sending an inline edit to the AI endpoint. No source was transmitted.');
 const system=mode==='explain'? 'Explain only the selected text supplied by the user, and do not discuss the full file, other functions or earlier tasks. Reply with one JSON object {"type":"answer","message":"..."}.':
 'You are editing only the selected text, or inserting at the cursor when the selection is empty. Do not change other code.  Reply with exactly one JSON object {"type":"replacement","text":"COMPLETE replacement for the selected characters"}. Do not return path names, instructions, explanations, Markdown fences, or full file content. Preserve indentation and syntax. Do not modify unselected text. If unable, use {"type":"answer","message":"reason"}.';
 return [{role:'system',content:system},{role:'user',content:`${snapshot.cursor?'Insert at the cursor. No selected text; use only bounded adjacent context.':'Replace only the selected characters.'}\n${snapshot.cursor?'Adjacent context (read-only): '+redactContext(snapshot.adjacent)+'\n':''}File: ${snapshot.relative}\nLanguage: ${snapshot.language}\nSelection starts at line ${snapshot.range.start.line+1}, character ${snapshot.range.start.character+1}; ends at line ${snapshot.range.end.line+1}, character ${snapshot.range.end.character+1}.\nUser request: ${redactContext(prompt)}\n<selected_text>\n${mode==='explain'?filtered:snapshot.original}\n</selected_text>`}];
}
function parseSelectionReply(raw,mode='edit'){
 let obj;try{obj=JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw Error('Model must return one valid JSON replacement or explanation for the selected code.');}
 if(!obj||typeof obj!=='object')throw Error('Invalid selection response');
 if(mode==='explain'&&obj.type==='answer'&&typeof obj.message==='string')return {type:'answer',message:repairMojibake(obj.message)};
 if(mode==='edit'&&obj.type==='answer'&&typeof obj.message==='string')return {type:'answer',message:repairMojibake(obj.message)};
 if(mode==='edit'&&obj.type==='replacement'&&typeof obj.text==='string'&&obj.text.length<=30000){
  if(obj.text.includes('\uFFFD')||obj.text.includes('\uFEFF')||(repairMojibake(obj.text)!==obj.text&&obj.text.length-repairMojibake(obj.text).length>=2))throw Error('Model proposed corrupted Unicode text; no edit staged.');
  return {type:'replacement',text:obj.text};
 }
 throw Error('Expected a selected-text replacement, not a full-file edit or repository tool action.');
}
async function askSelected({snapshot,prompt,mode,transport,config,apiKey,signal}){
 const response=await transport.request({url:config.baseUrl+'/chat/completions',method:'POST',apiKey,authMode:config.authMode,...proxyFields(config),userAgent:config.userAgent,timeoutSeconds:config.timeoutSeconds,body:{model:config.model,messages:selectionMessages(snapshot,prompt,mode),max_tokens:config.outputTokens||4096,stream:false},signal});
 if(response.data?.choices?.[0]?.finish_reason==='length')throw Error('Model reached output-token limit. Selection was not modified.');
 return parseSelectionReply(getContent(response.data),mode);
}
module.exports={repairMojibake,captureSelection,selectionMessages,parseSelectionReply,askSelected};
