'use strict';
const path=require('node:path');
/** Virtual filenames retain the destination extension so VS Code applies .py/.js syntax highlighting. */
function previewUriPath(id,target){
 if(!/^[a-f0-9]{8,64}$/i.test(id))throw Error('Invalid preview identifier');
 const filename=path.win32.basename(String(target).replace(/\//g,'\\'));
 if(!filename||filename==='.'||filename==='..')throw Error('Invalid preview file name');
 return '/'+id+'/'+encodeURIComponent(filename);
}
function inlineEditRequest({file,start,end,prompt}){
 if(!file||typeof prompt!=='string'||!prompt.trim())throw Error('Missing target file or edit request');
 const lines=Number.isInteger(start)&&Number.isInteger(end)?`selected lines ${start}-${end}`:'the active file';
 return `INLINE EDIT: Modify only ${file}, focusing on ${lines}. User request: ${prompt.trim()}\n`+
  'Use a small targeted find/replace patch whenever modifying an existing file, never create a .txt file for Python code. '+
  'Do not change any other file. Propose code only; host diff preview and explicit user approval are mandatory before saving.';
}
module.exports={previewUriPath,inlineEditRequest};
