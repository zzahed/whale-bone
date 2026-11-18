'use strict';
/** Optional interactive preview at the model-request boundary. The API key and
 * transport metadata are deliberately excluded from the preview; the messages
 * shown are the same messages handed to the unchanged transport implementation. */
function createReviewedTransport(transport,{enabled,review,assertCurrent}={}){
 if(typeof transport?.request!=='function')throw Error('Transport request function required');
 if(typeof enabled!=='function'||typeof review!=='function'||typeof assertCurrent!=='function')throw Error('Outbound review requires authorization callbacks');
 return {request:async options=>{
  assertCurrent();
  if(options.signal?.aborted)throw Error('Request cancelled before outbound review.');
  const isContextCall=options.method==='POST'&&Array.isArray(options.body?.messages);
  const reviewRequired=!!enabled()&&isContextCall;
  if(reviewRequired){
   const preview=JSON.stringify({destination:new URL(options.url).origin,model:options.body.model,messages:options.body.messages},null,2);
   if(!await review(preview,options))throw Error('Outbound context review declined. No request transmitted.');
  }
  assertCurrent();
  if(isContextCall&&!reviewRequired&&enabled())throw Error('Outbound review setting changed before transmission. Retry to review the context.');
  if(options.signal?.aborted)throw Error('Request cancelled before transmission.');
  return transport.request(options);
 }};
}
module.exports={createReviewedTransport};
