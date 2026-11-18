'use strict';
/** In-editor preview: decorations + CodeLens. No temporary source file and no auto-save. */
class InlineReviewManager {
 constructor(vscode){this.vscode=vscode;this.items=new Map();this.emitter=new vscode.EventEmitter();this.onDidChangeCodeLenses=this.emitter.event;
  this.decoration=vscode.window.createTextEditorDecorationType({backgroundColor:vscode.ThemeColor?new vscode.ThemeColor('diffEditor.removedTextBackground'):'rgba(220,75,75,0.18)',isWholeLine:false,after:{color:vscode.ThemeColor?new vscode.ThemeColor('descriptionForeground'):'gray',margin:'0 0 0 1em'}});
 }
 key(uri){return uri.toString();}
 position(p){return this.vscode.Position?new this.vscode.Position(p.line,p.character):p;}
 range(a,b){return new this.vscode.Range(this.position(a),this.position(b));}
 update(uri,text,snapshot,tracker){const key=this.key(uri);const item=this.items.get(key);if(!item)throw Error('No pending suggestion to retry');item.tracker?.dispose?.();item.text=text;if(snapshot)item.snapshot=snapshot;item.tracker=tracker;this.refresh();return key;}
 stage(editor,snapshot,text,tracker){const key=this.key(snapshot.uri);if(this.items.has(key))throw Error('An inline edit is already pending for this file. Accept or Reject it first.');this.items.set(key,{snapshot,text,tracker});this.refresh();return key;}
 refresh(){for(const editor of this.vscode.window.visibleTextEditors||[]){const item=this.items.get(this.key(editor.document.uri));const options=[];if(item){const {snapshot,text}=item;const lines=text.split(/\r?\n/);const glimpse=lines[0].slice(0,140);options.push({range:this.range(snapshot.range.start,snapshot.range.end),hoverMessage:`Whale Bone replacement (${lines.length} line(s)):\n\n\x60\x60\x60${snapshot.language}\n${text.slice(0,12000)}\n\x60\x60\x60`,renderOptions:{after:{contentText:`  ⇢ ${glimpse}${lines.length>1?' …':''}`}}});}editor.setDecorations?.(this.decoration,options);}this.emitter.fire?.();}
 provideCodeLenses(doc){const item=this.items.get(this.key(doc.uri));if(!item||!this.vscode.CodeLens)return [];const r=this.range(item.snapshot.range.start,item.snapshot.range.start);return [new this.vscode.CodeLens(r,{title:'Whale Bone: Accept selection edit',command:'whaleBone.acceptInline',arguments:[this.key(doc.uri)]}),new this.vscode.CodeLens(r,{title:'Reject',command:'whaleBone.rejectInline',arguments:[this.key(doc.uri)]}),new this.vscode.CodeLens(r,{title:'Retry suggestion',command:'whaleBone.retryInline',arguments:[this.key(doc.uri)]}),new this.vscode.CodeLens(r,{title:'Review detailed diff',command:'whaleBone.previewInline',arguments:[this.key(doc.uri)]})];}
 register(context){context.subscriptions.push(this.decoration,this.emitter);if(this.vscode.languages?.registerCodeLensProvider)context.subscriptions.push(this.vscode.languages.registerCodeLensProvider({scheme:'file'},this));}
 reject(uri){const key=String(uri);this.items.get(key)?.tracker?.dispose?.();this.items.delete(key);this.refresh();}
 async accept(uri){const item=this.items.get(String(uri));if(!item)throw Error('No pending inline proposal for this editor');const {snapshot,text}=item;
  const doc=(this.vscode.workspace.textDocuments||[]).find(d=>this.key(d.uri)===String(uri));if(!doc)throw Error('Original editor is unavailable; reopen and retry.');
  if((item.tracker&&!item.tracker.valid())||doc.version!==snapshot.version||doc.getText(this.range(snapshot.range.start,snapshot.range.end))!==snapshot.original){this.reject(uri);throw Error('Selected code changed after AI preview. Regenerate the proposal before applying.');}
  const change=new this.vscode.WorkspaceEdit();change.replace(snapshot.uri,this.range(snapshot.range.start,snapshot.range.end),text);
  if(!await this.vscode.workspace.applyEdit(change))throw Error('VS Code rejected the selected-text edit.');this.reject(uri);return true;
 }
}
module.exports={InlineReviewManager};
