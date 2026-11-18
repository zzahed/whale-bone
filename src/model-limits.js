'use strict';
/** UI capacity ceilings, NOT promises about limits enforced by the API provider.
 * The server's selected deployment can impose stricter quotas. */
const MIN_CONTEXT_TOKENS=8192, MAX_CONTEXT_TOKENS=2097152;
const MIN_OUTPUT_TOKENS=256, MAX_OUTPUT_TOKENS=262144;
const DEFAULT_CONTEXT_TOKENS=131072, DEFAULT_OUTPUT_TOKENS=65536;
function validateLimits({contextWindowTokens,outputTokens}={}){
 if(!Number.isSafeInteger(outputTokens)||outputTokens<MIN_OUTPUT_TOKENS||outputTokens>MAX_OUTPUT_TOKENS)
  throw Error(`Output tokens must be ${MIN_OUTPUT_TOKENS}–${MAX_OUTPUT_TOKENS}`);
 if(!Number.isSafeInteger(contextWindowTokens)||contextWindowTokens<MIN_CONTEXT_TOKENS||contextWindowTokens>MAX_CONTEXT_TOKENS)
  throw Error(`Context window must be ${MIN_CONTEXT_TOKENS}–${MAX_CONTEXT_TOKENS} tokens`);
 return {outputTokens,contextWindowTokens};
}
function advertisedInteger(v,min=MIN_CONTEXT_TOKENS){return Number.isSafeInteger(v)&&v>=min?v:null;}
/** Only accept limits for the exact selected model. Never silently claim that
 * a model's theoretical limits are a guarantee from the provider deployment. */
function selectModelMaximum(model,record){
 let context=null,output=null;
 if(record&&typeof record==='object'&&record.id===model){
  context=advertisedInteger(record.context_length??record.context_window??record.max_model_len??record.max_context_length??record.limits?.context_window);
  output=advertisedInteger(record.max_output_tokens??record.max_completion_tokens??record.output_token_limit??record.limits?.max_output_tokens,MIN_OUTPUT_TOKENS);
 }
 if(!context&&/^openai\/gpt-oss-(?:120b|20b)$/.test(model))context=131072;
 if(!output&&/^openai\/gpt-oss-(?:120b|20b)$/.test(model))output=131072;
 if(!context)return null;
 const contextWindowTokens=Math.min(MAX_CONTEXT_TOKENS,context);
 return {contextWindowTokens,outputTokens:Math.max(MIN_OUTPUT_TOKENS,Math.min(MAX_OUTPUT_TOKENS,output||contextWindowTokens))};
}
module.exports={MIN_CONTEXT_TOKENS,MAX_CONTEXT_TOKENS,MIN_OUTPUT_TOKENS,MAX_OUTPUT_TOKENS,DEFAULT_CONTEXT_TOKENS,DEFAULT_OUTPUT_TOKENS,validateLimits,selectModelMaximum};
