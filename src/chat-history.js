'use strict';
/** Convert supported VS Code Chat turns to bounded, text-only context. */
function conversationHistory(turns){
 if(!Array.isArray(turns))return [];
 const records=[];
 for(const turn of turns.slice(-8)){
  if(typeof turn?.prompt==='string' && turn.prompt.trim())records.push({role:'user',text:turn.prompt.slice(0,4000)});
  else if(Array.isArray(turn?.response)){
   const text=turn.response.map(x=>{
    if(typeof x==='string')return x;
    if(typeof x?.value==='string')return x.value;
    if(typeof x?.value?.value==='string')return x.value.value;
    return '';
   }).filter(Boolean).join('\n').slice(0,4000);
   if(text)records.push({role:'assistant',text});
  }
 }
 return records.slice(-8);
}
module.exports={conversationHistory};
