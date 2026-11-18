'use strict';
/** Opt-in, non-streaming inline completions. Never asks the user for consent on a keystroke. */
const {getContent}=require('./protocol');
const {proxyFields}=require('./transport');
const {repairMojibake}=require('./selection-edit');
const {redactContext}=require('./workspace');
const {redactedLines}=require('./redaction');
const DEFAULTS=Object.freeze({enabled:false,delayMs:750,minGapMs:2500,maxChars:700});
function parseCompletion(raw){let obj;
 try{obj=JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw Error('Invalid JSON completion');}
 if(obj?.type!=='completion'||typeof obj.text!=='string')throw Error('Invalid completion response');
 const text=obj.text;if(!text.trim()||text.length>DEFAULTS.maxChars||/\u0000|\uFFFD|\uFEFF/.test(text)||(repairMojibake(text)!==text&&text.length-repairMojibake(text).length>=2))throw Error('Corrupted Unicode or oversized completion');
 return text;
}
function editorPrefix(document,position,Range){
 // Prefer VS Code's random-access document API: slicing a bounded text range
 // avoids allocating/splitting the entire buffer for every keystroke.
 if(typeof Range==='function'&&typeof document.positionAt==='function'&&typeof document.offsetAt==='function'){
  const at=document.offsetAt(position);
  if(!Number.isSafeInteger(at)||at<0)return null;
  const before=document.positionAt(Math.max(0,at-2500));
  const after=document.positionAt(at+350);
  return {prefix:String(document.getText(new Range(before,position))),suffix:String(document.getText(new Range(position,after))),cursorOffset:at};
 }
 const source=String(document.getText());
 const lines=source.split(/\r\n|\n|\r/);
 if(position.line<0||position.line>=lines.length||position.character<0||position.character>lines[position.line].length)return null;
 let at;
 if(typeof document.offsetAt==='function')at=document.offsetAt(position);
 else { // VS Code mocks and non-editor callers: count the actual line endings, including CRLF.
   const re=/\r\n|\r|\n/g;let i=0,m,offset=0;
   while(i<position.line&&(m=re.exec(source))!==null){offset=m.index+m[0].length;i++;}
   at=offset+position.character;
 }
 if(!Number.isInteger(at)||at<0||at>source.length)return null;
 return {prefix:source.slice(Math.max(0,at-2500),at),suffix:source.slice(at,at+350),cursorOffset:at};
}
function waitDebounce(ms,token){return new Promise(resolve=>{if(token?.isCancellationRequested)return resolve(false);
 const t=setTimeout(()=>{d?.dispose?.();resolve(!token?.isCancellationRequested);},Math.max(0,ms));
 const d=token?.onCancellationRequested?.(()=>{clearTimeout(t);resolve(false);});
 });}
class WhaleBoneAutocomplete{
 constructor({vscode,getSettings,getAuthorization,isAllowed=()=>true,isAuthorizationCurrent=()=>true,getScopeKey=()=>'',now=()=>Date.now()}){
  this.vscode=vscode;this.getSettings=getSettings;this.getAuthorization=getAuthorization;this.isAllowed=isAllowed;this.isAuthorizationCurrent=isAuthorizationCurrent;this.getScopeKey=getScopeKey;this.now=now;this.lastAt=0;this.active=null;this.cache=new Map();this.sensitiveCache=new Map();this.generation=0;
 }
 async provideInlineCompletionItems(document,position,context,token){
  const cfg=this.getSettings()||DEFAULTS;
  if(!cfg.enabled||token?.isCancellationRequested||document.uri?.scheme!=='file'||!this.isAllowed(document))return [];
  // Capturing the request scope prevents cached or asynchronous completions
  // from crossing a workspace, endpoint or consent change.
  let scope;
  try{scope=this.getScopeKey();}catch{return [];}
  const generation=this.generation;
  const capturedVersion=document.version;
  const current=()=>{try{return generation===this.generation&&!token?.isCancellationRequested&&document.version===capturedVersion&&
   !!this.getSettings()?.enabled&&this.isAllowed(document)&&this.getScopeKey()===scope;}catch{return false;}};
  // No AI autocomplete on huge buffers. Avoid getText() on documents where
  // even a full-file redaction safety scan would create a large allocation.
  if(typeof document.lineAt==='function'&&Number.isInteger(document.lineCount)&&typeof document.offsetAt==='function'){
   try{const end=document.lineAt(document.lineCount-1).range.end;if(document.offsetAt(end)>250000)return [];}catch{return [];}
  }
  const x=editorPrefix(document,position,this.vscode.Range);if(!x||x.prefix.trim().length<8)return [];
  // Fail closed when a credential block crosses the cursor boundary. Redacting
  // prefix and suffix separately can miss multiline YAML secret continuations.
  if(redactContext(x.prefix+x.suffix)!==x.prefix+x.suffix)return [];
  if(!await waitDebounce(cfg.delayMs??DEFAULTS.delayMs,token))return [];
  if(!current())return [];
  // Detect multiline values whose opening key is outside the bounded prefix.
  // Suppress completion for any snippet that overlaps a sensitive full-file line.
  const cacheKey=String(document.uri.toString?.()||document.uri.fsPath)+':'+capturedVersion;
  let sensitivity=this.sensitiveCache.get(cacheKey);
  if(!sensitivity){
   const source=String(document.getText());if(source.length>250000)return [];
   sensitivity={firstLine:source.slice(0,Math.max(0,x.cursorOffset-2500)).split(/\r\n|\r|\n/).length,
    lastLine:source.slice(0,Math.min(source.length,x.cursorOffset+350)).split(/\r\n|\r|\n/).length,
    lines:redactedLines(source)};
   this.sensitiveCache.set(cacheKey,sensitivity);
   if(this.sensitiveCache.size>4)this.sensitiveCache.delete(this.sensitiveCache.keys().next().value);
  }else{
   const source=String(document.getText());
   sensitivity.firstLine=source.slice(0,Math.max(0,x.cursorOffset-2500)).split(/\r\n|\r|\n/).length;
   sensitivity.lastLine=source.slice(0,Math.min(source.length,x.cursorOffset+350)).split(/\r\n|\r|\n/).length;
  }
  if(sensitivity.lines.some(line=>line>=sensitivity.firstLine&&line<=sensitivity.lastLine))return [];
  if(!current())return [];
  const key=JSON.stringify([scope,document.uri.toString?.()||document.uri.fsPath,capturedVersion,position.line,position.character,x.prefix.slice(-80)]);
  const cached=this.cache.get(key);if(cached&&this.now()-cached.at<45000)return cached.items;
  // Explicit VS Code inline suggestion requests are allowed to bypass automatic throttle.
  if(context?.triggerKind!==this.vscode.InlineCompletionTriggerKind?.Invoke&&this.now()-this.lastAt<(cfg.minGapMs??DEFAULTS.minGapMs))return [];
  // Authorization MUST be non-interactive, and refuse an untrusted/unauthorized path.
  const allowed=await this.getAuthorization(document);if(!allowed?.approved)return [];
  // A credential lookup can await SecretStorage or another provider. Consent,
  // destination, document version, settings and cancellation may change meanwhile.
  if(!current()||!this.isAuthorizationCurrent(document,allowed))return [];
  if(this.active)this.active.abort();const abort=new AbortController();this.active=abort;
  const disposable=token?.onCancellationRequested?.(()=>abort.abort());this.lastAt=this.now();
  try{
   const c=allowed.config;
   const res=await allowed.transport.request({url:c.baseUrl+'/chat/completions',method:'POST',apiKey:allowed.key,authMode:c.authMode,...proxyFields(c),userAgent:c.userAgent,timeoutSeconds:Math.min(45,c.timeoutSeconds),signal:abort.signal,
    body:{model:c.model,stream:false,max_tokens:Math.min(c.outputTokens||256,256),messages:[{role:'system',content:'Complete source at the cursor. Return exactly {"type":"completion","text":"inserted code only"}. Never include Markdown, explanation or existing prefix. Maximum 700 characters. Do not repeat surrounding source. Do not access other files.'},
     {role:'user',content:`Language: ${document.languageId||'text'}\n<BEFORE>\n${redactContext(x.prefix)}\n</BEFORE>\n<CURSOR/>\n<AFTER>\n${redactContext(x.suffix)}\n</AFTER>`}]}});
   if(abort.signal.aborted||!current()||!this.isAuthorizationCurrent(document,allowed))return [];
   if(res.data?.choices?.[0]?.finish_reason==='length')return [];
   const text=parseCompletion(getContent(res.data));
   const r=new this.vscode.Range(position,position);const items=[new this.vscode.InlineCompletionItem(text,r)];
   this.cache.set(key,{at:this.now(),items});if(this.cache.size>30)this.cache.delete(this.cache.keys().next().value);
   return items;
  }catch{return [];}finally{disposable?.dispose?.();if(this.active===abort)this.active=null;}
 }
 invalidate(){this.generation++;this.active?.abort();this.active=null;this.cache.clear();this.sensitiveCache.clear();}
 dispose(){this.invalidate();}
}
module.exports={DEFAULTS,parseCompletion,editorPrefix,WhaleBoneAutocomplete};
