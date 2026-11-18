'use strict';
const path=require('node:path');const {Worker}=require('node:worker_threads');
function request(operation,root,params={},signal){
 if(signal?.aborted)return Promise.reject(Error('Repository operation cancelled'));
 return new Promise((resolve,reject)=>{
  const worker=new Worker(path.join(__dirname,'search-worker.js'),{workerData:{operation,root,...params}});
  let settled=false;
  const settle=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener?.('abort',cancel);void worker.terminate();if(error)reject(error);else resolve(result);};
  const cancel=()=>settle(Error('Repository operation cancelled'));
  const timer=setTimeout(()=>settle(Error('Repository operation timed out. Narrow the search; no result was considered complete.')),20000);
  signal?.addEventListener?.('abort',cancel,{once:true});
  worker.on('message',message=>message.ok?settle(null,message.result):settle(Error(message.error)));
  worker.on('error',error=>settle(error));
  worker.on('exit',code=>{if(!settled)settle(Error(`Repository worker stopped (code ${code})`));});
  if(signal?.aborted)cancel();
 });
}
module.exports={search:(root,query,options={})=>request('search',root,{query},options.signal),list:(root,folder='.',cursor=0,signal)=>request('list',root,{folder,cursor},signal),intro:(root,signal)=>request('intro',root,{},signal)};
