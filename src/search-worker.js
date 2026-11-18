'use strict';
/** Run bounded repository traversal off the VS Code extension-host event loop. */
const {parentPort,workerData}=require('node:worker_threads');
const W=require('./workspace');
try{
 const {operation,root,query,folder,cursor}=workerData;
 let result;
 if(operation==='search')result=W.searchWithCoverage(root,query,{maxBytes:12_000_000,timeBudgetMs:10000});
 else if(operation==='list')result=W.listPage(root,folder||'.',cursor||0);
 else if(operation==='intro')result=W.listWithCoverage(root,folder||'.');
 else throw Error('Invalid repository worker operation');
 parentPort.postMessage({ok:true,result});
}catch(e){parentPort.postMessage({ok:false,error:String(e?.message||e).slice(0,400)});}
