'use strict';
const Limits=require('./model-limits');
/** Conservative model-independent estimate, not a true tokenizer. Actual
 * tokenizer and provider deployment limits vary. Byte count / 2 tends to
 * overestimate ordinary English and many code samples. */
function estimatedTokens(value){return Math.ceil(Buffer.byteLength(JSON.stringify(value),'utf8')/2);}
const SYSTEM_RESERVE_TOKENS=2048;
const MIN_REPLY_RESERVE_TOKENS=4096;
function inputTokenBudget({contextWindowTokens=Limits.DEFAULT_CONTEXT_TOKENS}={}){
 const window=Number.isSafeInteger(contextWindowTokens)?Math.max(Limits.MIN_CONTEXT_TOKENS,Math.min(Limits.MAX_CONTEXT_TOKENS,contextWindowTokens)):Limits.DEFAULT_CONTEXT_TOKENS;
 return Math.max(1024,window-SYSTEM_RESERVE_TOKENS-MIN_REPLY_RESERVE_TOKENS);
}
function effectiveMaxOutput({contextWindowTokens=Limits.DEFAULT_CONTEXT_TOKENS,outputTokens=Limits.DEFAULT_OUTPUT_TOKENS}={},messages){
 const window=Number.isSafeInteger(contextWindowTokens)?contextWindowTokens:Limits.DEFAULT_CONTEXT_TOKENS;
 const limit=Number.isSafeInteger(outputTokens)?outputTokens:Limits.DEFAULT_OUTPUT_TOKENS;
 const remaining=window-estimatedTokens(messages)-SYSTEM_RESERVE_TOKENS;
 if(remaining<Limits.MIN_OUTPUT_TOKENS)throw Error('Model context is full. Reduce attached source or choose a larger supported context window.');
 return Math.min(Limits.MAX_OUTPUT_TOKENS,limit,remaining);
}
function compactHistory(history,{keepRecent=6}={}){
 if(!Array.isArray(history)||history.length<=keepRecent)return Array.isArray(history)?history:[];
 const old=history.slice(0,-keepRecent),recent=history.slice(-keepRecent);
 const snippets=old.slice(-12).map(item=>(item?.role==='assistant'?'Assistant':'User')+': '+String(item?.text||'').replace(/\s+/g,' ').slice(0,135));
 return [{role:'user',text:'Earlier conversation (abbreviated, verify important decisions from files):\n'+snippets.join('\n').slice(0,2000)},...recent];
}
module.exports={estimatedTokens,inputTokenBudget,effectiveMaxOutput,compactHistory,SYSTEM_RESERVE_TOKENS,MIN_REPLY_RESERVE_TOKENS};
