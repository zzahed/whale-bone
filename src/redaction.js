'use strict';
/** Best-effort AI-context masking. Never mutate workspace files or rewrite code before editing. */
const MASK='[REDACTED]';
const NON_VALUES=/^(?:none|null|nil|undefined|true|false|str|string|int|float|bool|boolean|number|object|any|never|unknown|byte|bytes|password|passwd|pwd|token|key|value|confirm|args|env|config|settings|this|self)$/i;
function credentialKey(raw){
 const key=String(raw).replace(/^\$?(?:env:)?/i,'').split('.').pop().replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/-/g,'_').toLowerCase();
 if(/^(?:max_tokens?|tokenizer|token_count|secret_name|credential(?:s)?_path|token_url|password_hint|password_field|password_prompt|token_type|token_endpoint|access_token_url)$/.test(key))return false;
 return /^(?:secret|secret_key|subscription_key|azure_openai_key|aws_access_key_id|github_pat|account_key|azure_storage_connection_string|pgpassword|password|passwd|pwd|db_pass|db_passwd|db_pwd|database_pass|database_passwd|database_pwd|token|authorization|api_key|private_key|db_password|database_password|aws_secret_access_key|github_token|client_secret|client_password|secret_access_key|access_token|refresh_token|auth_token|session_token|bearer_token|service_token|smtp_password|jwt_secret|signing_secret|[a-z0-9_]+_(?:password|passwd|api_key|subscription_key|secret_key|access_key|access_key_id|auth_token|access_token|refresh_token|secret|token|pat|connection_string))$/.test(key);
}
function literal(raw,quoted=false,allowBareWord=false){
 const s=String(raw).trim();
 if(!s||s===MASK||/^(?:\$\{|\{\{|<[^>]+>|\*+$)/.test(s))return false;
 if(quoted)return true;
 // Identifiers, expressions, type annotations and placeholders must remain editable.
 if(NON_VALUES.test(s)||/^(?:env|config|settings|args|opts|self|this|ctx)[A-Z][A-Za-z0-9_]*$/.test(s)||/^\w+(?:\.\w+|\[[^\]]+\]|\([^)]*\))/.test(s)||/^\$[A-Za-z_][\w:]*/.test(s))return false;
 if(!allowBareWord&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)&&!/[A-Z]/.test(s)&&!/[0-9]/.test(s))return false;
 if(/[+*/()[\]{}]|\s=/.test(s))return false;
 return true;
}
function maskValue(raw,allowBareWord=false){
 const v=String(raw),initial=v.match(/^\s*/)[0],end=v.match(/\s*$/)[0],core=v.slice(initial.length,v.length-end.length);
 if(!core)return v;
 const q=core[0];
 if((q==='"'||q==="'"||q==='`')&&core.length>=2&&core.endsWith(q))return literal(core.slice(1,-1),true)?initial+q+MASK+q+end:v;
 // Keep YAML comments intact without including them in the secret.
 const comment=core.match(/^(.*?)(\s+#.*)$/);
 if(comment)return literal(comment[1],false,allowBareWord)?initial+MASK+comment[2]+end:v;
 return literal(core,false,allowBareWord)?initial+MASK+end:v;
}
/** Identify sensitive assignment VALUES without consuming intervening non-secret
 * assignments. A full-value global regex skipped `password` in
 * `const cfg = { password: "..." }` because it consumed the preceding `cfg = {`.
 * Match only the key and delimiter, then replace value spans right-to-left.
 */
function redactAssignments(input){
 const assignment=/(^|[\s;{(,])((?:(?:export|set|var|let|const|String|char|auto|final|private|public|protected|static)\s+)*)(\$env:)?(\$?[A-Za-z_][A-Za-z0-9_.-]*)(\s*(?:=(?!=)|:=(?!=)|:(?![:=]))\s*)/g;
 const valuePattern=/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^;,)}\r\n]+)/;
 const edits=[];
 for(const match of input.matchAll(assignment)){
  const [,boundary,declaration,envPrefix,key,operator]=match;
  if(!credentialKey(key))continue;
  const start=match.index+match[0].length;
  const candidate=input.slice(start).match(valuePattern);
  if(!candidate)continue;
  const allowBareWord=operator.trim().startsWith(':')||!!envPrefix||/\b(?:export|set)\b/i.test(declaration)||key.includes('.')||boundary===';'||(/^[A-Z][A-Z0-9_]*$/.test(key)&&key.includes('_'));
  const replacement=maskValue(candidate[0],allowBareWord);
  if(replacement!==candidate[0])edits.push({start,end:start+candidate[0].length,replacement});
 }
 for(let i=edits.length-1;i>=0;i--){const {start,end,replacement}=edits[i];input=input.slice(0,start)+replacement+input.slice(end);}
 return input;
}
function redactXmlConfig(input){
 // ASP.NET/web.config <add> attributes can appear in either order. Match within
 // one tag only; never redact unrelated 'value=' attributes.
 return input.replace(/<add\b[^>\r\n]*>/gi,tag=>{
  const key=tag.match(/\bkey\s*=\s*(["'])([^"']+)\1/i);
  if(!key||!credentialKey(key[2]))return tag;
  return tag.replace(/(\bvalue\s*=\s*)(["'])([^"']*)\2/i,(all,before,quote,value)=>
   literal(value,true)?before+quote+MASK+quote:all);
 });
}
/** Handle credentials embedded in a connection-string value or XML attribute.
 * An attribute may contain several semicolon-delimited properties; scanning the
 * inner property avoids consuming its closing quote or XML tag delimiter.
 */
function redactConnectionStrings(line){
 return line.replace(/\b(password|passwd|pwd|db_password|database_password|access_token|client_secret)\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;"'<>\u0026]+)/gi,(whole)=>{
  const parts=whole.match(/^(\s*[^=]+?\s*=\s*)(.*)$/);
  if(!parts)return whole;
  const replacement=maskValue(parts[2],true);
  return replacement===parts[2]?whole:parts[1]+replacement;
 });
}
/** Preserve plain type annotations, but mask literal assignments with a type.
 * Both Python `password: str = ...` and TypeScript `let password: string = ...`
 * must be masked without changing `password: str` or `password: string;`.
 */
function redactTypedAssignments(line){
 return line.replace(/\b(\$?[A-Za-z_][A-Za-z_0-9]*)\s*:\s*(?:str|string|number|int|float|bool|boolean|bytes|unknown|any)(?:\s*\|\s*(?:null|undefined|None))?\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^;,)}\r\n]+)/g,(whole,key)=>{
  if(!credentialKey(key))return whole;
  const pos=whole.lastIndexOf('=')+1;
  const replacement=maskValue(whole.slice(pos));
  return whole.slice(0,pos)+replacement;
 });
}
function redactStructuredValues(line){
 // A wrapper object for a secret may put the literal in its `value` property.
 return line.replace(/\b(\$?[A-Za-z_][\w.-]*)\s*:\s*\{\s*value\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;}\r\n]+)/gi,(all,key,value)=>{
  if(!credentialKey(key))return all;
  const pos=all.lastIndexOf(value);
  return all.slice(0,pos)+maskValue(value,true);
 });
}
function redactLine(raw){
 let s=String(raw);
 // Git diff content lines start with a single + or -. Strip the marker before
 // recognizing credentials, then restore it. Do not process +++/--- headers.
 let diff='';const match=s.match(/^(\s*[+-])(?![+-])/);
 if(match){diff=match[1];s=s.slice(diff.length);}
 // Authorization and URI user-info are always sensitive, independent of key-value syntax.
 s=s.replace(/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+\/=\-]{9,})\b/gi,(_all,kind,space)=>kind+space+MASK);
 // Secrets in URL query strings are not conventional assignments: the key is
 // preceded by ? or &, not whitespace. Preserve harmless query parameters.
 s=s.replace(/([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|sig|signature|subscription[_-]?key)\s*=\s*)([^&#;\s\"'<>]+)/gi,
  (_whole,key)=>key+MASK);
 // Recognizable tokens also occur without labels, for example in pasted logs.
 // Keep length thresholds to avoid mangling ordinary variable names.
 s=s.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,MASK);
 s=s.replace(/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/[^\s:@/]+:)([^@\s/]+)(@)/gi,(_all,prefix,_value,at)=>prefix+MASK+at);
 // Python assignments to os.environ['KEY'] cannot be recognized by the ordinary key scanner.
 s=s.replace(/(\bos\.environ\s*\[\s*['"])([A-Za-z_][A-Za-z0-9_]*)(['"]\s*\]\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^;,)}\r\n]+)/g,
  (whole,prefix,key,assignment,value)=>credentialKey(key)?prefix+key+assignment+maskValue(value,true):whole);
 s=redactXmlConfig(s);
 s=redactConnectionStrings(s);
 s=redactTypedAssignments(s);
 s=redactStructuredValues(s);
 // Quoted JSON keys: keep the original quoting and structure.
 s=s.replace(/(["'])([A-Za-z_][A-Za-z0-9_-]*)\1(\s*:\s*)(["'])([^\r\n]*?)\4/g,(all,kq,key,colon,vq,value)=>credentialKey(key)&&literal(value,true)?kq+key+kq+colon+vq+MASK+vq:all);
 s=redactAssignments(s);
 // cmd.exe also permits: set "PASSWORD=value" (quoted assignment, not a quoted value).
 s=s.replace(/(\bset\s+")([A-Za-z_][A-Za-z0-9_]*)(=)([^"\r\n]*)(")/gi,(whole,start,key,eq,value,end)=>credentialKey(key)&&literal(value)?start+key+eq+MASK+end:whole);
 return diff+s;
}
function redactText(value){
 const parts=String(value).split(/(\r?\n)/);
 let blockIndent=null;
 for(let i=0;i<parts.length;i+=2){
  const line=parts[i];
  // Unified diff hunks add one + or - column to content lines. Exclude
  // +++/--- headers; preserve diff structure while masking block contents.
  const diff=line.match(/^(\s*[+-])(?![+-])/);
  const prefix=diff?diff[1]:'';
  const content=prefix?line.slice(prefix.length):line;
  if(blockIndent!==null){
   if(!content.trim()){parts[i]=line;continue;}
   const indentation=content.match(/^[ \t]*/)[0].length;
   if(indentation>blockIndent){parts[i]=prefix+content.match(/^[ \t]*/)[0]+MASK;continue;}
   blockIndent=null;
  }
  const marker=content.match(/^(\s*)(?:-\s*)?["']?([A-Za-z_][\w.-]*)["']?\s*:\s*[|>][+-]?\d?\s*(?:#.*)?$/);
  if(marker&&credentialKey(marker[2]))blockIndent=marker[1].length;
  parts[i]=redactLine(line);
 }
 return parts.join('');
}
function redactedLines(before,after=redactText(before)){
 const a=String(before).split(/\r?\n/),b=String(after).split(/\r?\n/),result=[];
 for(let i=0;i<a.length;i++)if(a[i]!==b[i])result.push(i+1);
 return result;
}
module.exports={MASK,credentialKey,redactText,redactedLines};
