'use strict';
const {checkFile,windowsSame}=require('./workspace');
/** Revalidate the exact selected document and approval before and after every
 * asynchronous operation. A captured selection is not itself authorization. */
function assertNativeSelectionCurrent({vscode,provider,editor,snapshot,root,endpoint,getEndpoint,token,allowReviewPreview=false}) {
 if(token?.isCancellationRequested)throw Error('Native selection request cancelled.');
 if(!vscode.workspace.isTrusted)throw Error('Workspace trust was revoked during native selection.');
 if(!root||provider.root!==root)throw Error('Selected workspace changed during native selection.');
 if(getEndpoint()!==endpoint)throw Error('API destination changed during native selection.');
 if(!provider.hasConsent(root,endpoint))throw Error('Workspace AI data consent was revoked.');
 const doc=editor?.document;
 const active=vscode.window.activeTextEditor;
 const previewVisible=allowReviewPreview&&active?.document?.uri?.scheme==='whalebone-preview';
 if(!doc||(active!==editor&&!previewVisible)||doc.uri?.scheme!=='file')throw Error('Active editor changed during native selection.');
 const owner=vscode.workspace.getWorkspaceFolder?.(doc.uri);
 if(!owner||!windowsSame(owner.uri.fsPath,root))throw Error('Selection workspace changed.');
 checkFile(root,doc.uri.fsPath);
 if(doc.version!==snapshot.version)throw Error('Selected source changed during authorization.');
 const sel=editor.selection;
 if(!sel||sel.isEmpty||sel.start.line!==snapshot.range.start.line||sel.start.character!==snapshot.range.start.character||sel.end.line!==snapshot.range.end.line||sel.end.character!==snapshot.range.end.character)throw Error('Selected editor range changed during authorization.');
 const range=vscode.Range?new vscode.Range(snapshot.range.start,snapshot.range.end):snapshot.range;
 if(doc.getText(range)!==snapshot.original)throw Error('Selected source changed during authorization.');
}
module.exports={assertNativeSelectionCurrent};
