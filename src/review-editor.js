'use strict';
/** Reveal the on-disk saved document after the user's explicitly approved
 * Apply. Close only the VS Code diff whose original/proposed URIs are the
 * exact preview pair, leaving unrelated diff and editor tabs intact. */
async function revealAppliedFile(vscode,document,{original,proposed}={}){
 const id=uri=>uri&&typeof uri.toString==='function'?uri.toString():String(uri||'');
 if(original&&proposed){
  const tabs=vscode.window.tabGroups;
  if(tabs?.all&&typeof tabs.close==='function'){
   const matches=tabs.all.flatMap(g=>g.tabs||[]).filter(tab=>id(tab.input?.original)===id(original)&&id(tab.input?.modified)===id(proposed));
   for(const tab of matches){try{await tabs.close(tab);}catch{/* The editor may have already closed the preview. */}}
  }
 }
 return vscode.window.showTextDocument(document,{viewColumn:vscode.ViewColumn?.Active,preview:false,preserveFocus:false});
}
module.exports={revealAppliedFile};
