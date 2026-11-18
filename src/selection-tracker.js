'use strict';
/** Follow an exact selection while edits elsewhere in its original document are made.
 * VS Code change offsets are measured against the pre-edit document; apply them in
 * descending offset order. A change overlapping the selection invalidates the suggestion. */
function trackSelection(vscode,document,snapshot){
 let invalid=false,closed=false;
 // Real VS Code validates instanceof Position/Range; snapshots are plain serializable records.
 const position=p=>vscode.Position?new vscode.Position(p.line,p.character):p;
 const range=(a,b)=>vscode.Range?new vscode.Range(position(a),position(b)):{start:position(a),end:position(b)};
 snapshot.range=range(snapshot.range.start,snapshot.range.end);
 const initial=typeof document.offsetAt==='function'&&typeof document.positionAt==='function';
 let start=initial?document.offsetAt(snapshot.range.start):0;
 let end=initial?document.offsetAt(snapshot.range.end):0;
 const uri=document.uri?.toString?.();
 const listener=initial&&typeof vscode.workspace?.onDidChangeTextDocument==='function'
  ?vscode.workspace.onDidChangeTextDocument(event=>{
   if(closed||event.document?.uri?.toString?.()!==uri)return;
   const changes=[...(event.contentChanges||[])].sort((a,b)=>b.rangeOffset-a.rangeOffset);
   for(const c of changes){
    const from=c.rangeOffset,to=from+c.rangeLength,delta=c.text.length-c.rangeLength;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(c.rangeLength)){invalid=true;continue;}
    if(to<=start){start+=delta;end+=delta;}
    else if(from>=end&&!(start===end&&from===start)){} // change after selection
    else invalid=true;
   }
   if(!invalid){const a=document.positionAt(start),b=document.positionAt(end);
    snapshot.range=range(a,b);
    snapshot.version=document.version;
   }
  }):null;
 const active=!!listener;
 return {
  valid(){return !closed&&!invalid&&document.version===snapshot.version&&document.getText(snapshot.range)===snapshot.original;},
  dispose(){if(closed)return;closed=true;listener?.dispose?.();},
  get active(){return active;},
  get invalid(){return invalid;},
 };
}
module.exports={trackSelection};
