'use strict';
/** VS Code-native Node/npm package manager, independent of the API transport and pip. */
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const N=require('./npm-packages');
class NpmPackageUI{
 constructor(vscode,{getRoot,getNetwork,extensionRoot,globalState}={}){
  this.vscode=vscode;this.getRoot=getRoot;this.getNetwork=getNetwork;this.extensionRoot=extensionRoot;this.globalState=globalState;
  this.active=null;this.operationRoot=null;this.output=vscode.window.createOutputChannel('Whale Bone: npm Packages');
  this.workspaceChanges=vscode.workspace.onDidChangeWorkspaceFolders?.(event=>{
   if(this.active&&this.operationRoot&&event.removed?.some(folder=>path.resolve(folder.uri.fsPath)===path.resolve(this.operationRoot)))this.active.abort();
  });
 }
 dispose(){this.active?.abort();this.workspaceChanges?.dispose?.();this.output.dispose?.();}
 assertWorkspace(root){const current=this.getRoot?.()||this.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if(current){if(path.resolve(current)!==path.resolve(root))throw Error('Workspace changed. Reopen the npm manager.');}
  else if(path.resolve(root)!==path.resolve(os.homedir()))throw Error('Workspace closed or removed. Reopen the npm manager.');
  if(this.vscode.workspace.isTrusted===false)throw Error('Trust the VS Code workspace before managing npm packages.');
 }
 async locate(root){
  let tools=N.findNpmCli({root});if(tools)return tools;
  const saved=this.globalState?.get?.('whalebone.npmTools');if(saved){try{return N.validateTools(saved,root);}catch(e){throw Error('Previously saved Node/npm executables are unsafe or unavailable: '+e.message+' Reconfigure npm tools.');}}
  const ask=await this.vscode.window.showWarningMessage('Node.js and the npm CLI were not found automatically. Choose node.exe and npm-cli.js to configure them.',{modal:true},'Choose executables');
  if(ask!=='Choose executables')throw Error('Install Node.js with npm or select its executables.');
  const node=await this.vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,openLabel:'Select node.exe'});if(!node?.[0])return null;
  const cli=await this.vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,openLabel:'Select npm-cli.js'});if(!cli?.[0])return null;
  tools={node:node[0].fsPath,cli:cli[0].fsPath};
  tools=N.validateTools(tools,root);
  await this.globalState?.update?.('whalebone.npmTools',tools);return tools;
 }
 async open(){if(this.active)throw Error('An npm operation is already running');
  const v=this.vscode;
  const actions=[
   {label:'$(terminal) Run npm command',description:'Example: npm install -g yo generator-office',type:'command'},
   {label:'$(cloud-download) Install globally',description:'User-writable global prefix, no admin privileges required',type:'install-global'},
   {label:'$(package) Install in workspace',description:'Adds dependencies to the selected project',type:'install-local'},
   {label:'$(verified) npm ci in workspace',description:'Install from package-lock.json with scripts disabled',type:'ci'},
   {label:'$(list-unordered) List global packages',description:'Show installed global packages',type:'list-global'},
   {label:'$(list-unordered) List workspace packages',description:'Show local dependencies',type:'list-local'},
   {label:'$(trash) Uninstall globally',description:'Remove selected global npm packages',type:'uninstall-global'},
   {label:'$(trash) Uninstall in workspace',description:'Remove selected local npm packages',type:'uninstall-local'},
   {label:'$(debug) Test npm registry',description:'Verify metadata, package tarball and declared integrity without installing',type:'diagnose'},
   {label:'$(settings-gear) Reset saved Node/npm paths',description:'Clear manually selected executable paths to reselect approved tools',type:'reset-tools'},
  ];
  const picked=await v.window.showQuickPick(actions,{placeHolder:'Node.js and npm. Registry access via corporate NTLM proxy',ignoreFocusOut:true});if(!picked)return;
  if(picked.type==='reset-tools'){await this.globalState?.update?.('whalebone.npmTools',undefined);v.window.showInformationMessage('Saved npm executable paths cleared. Select approved Node.js and npm executables on the next operation.');return;}
  const root=this.getRoot?.()||v.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const scopeRoot=root||os.homedir();this.assertWorkspace(scopeRoot);
  let command;
  if(picked.type==='diagnose'){
   const name=await v.window.showInputBox({title:'Test npm registry',value:'yo',validateInput:x=>{try{N.parseCommand('npm install '+x);return null;}catch(e){return e.message;}}});if(!name)return;
   return this.execute({root:scopeRoot,diagnostic:name});
  }
  if(picked.type==='command'){
   const raw=await v.window.showInputBox({title:'Whale Bone npm command',value:'npm install -g yo generator-office',prompt:'Supported: npm install, install -g, ci, list, uninstall. No arbitrary command flags or shell.',ignoreFocusOut:true,validateInput:x=>{try{N.parseCommand(x);return null;}catch(e){return e.message;}}});if(!raw)return;
   command=N.parseCommand(raw);
  }else{
   const [action,global]=picked.type==='ci'?['ci','local']:picked.type.split('-');let packages=[];
   if(['install','uninstall'].includes(action)){
    const raw=await v.window.showInputBox({title:'npm '+action+(global==='global'?' globally':''),value:global==='global'&&action==='install'?'yo generator-office':'',prompt:'Registry package names separated by spaces. Scoped packages supported.',ignoreFocusOut:true,validateInput:x=>{try{N.parseCommand('npm '+action+(global==='global'?' -g':'')+' '+x);return null;}catch(e){return e.message;}}});if(!raw)return;
    packages=raw.split(/\s+/).filter(Boolean);
   }
   command=N.parseCommand('npm '+action+(global==='global'?' -g':'')+(packages.length?' '+packages.join(' '):''));
  }
  if(!command.global&&!root)throw Error('Open a VS Code workspace to run local npm operations.');
  return this.execute({root:scopeRoot,command});
 }
 async execute({root,command,diagnostic}={}){
  if(this.active)throw Error('An npm operation is already in progress');this.assertWorkspace(root);
  const vscode=this.vscode,tools=await this.locate(root);if(!tools)return;this.assertWorkspace(root);
  const prefix=N.userPrefix(),label=diagnostic?'Registry test for '+diagnostic:'npm '+command.action+(command.global?' -g':'')+' '+command.packages.join(' ');
  const destructiveNotice=command?.action==='ci'?'\nIMPORTANT: npm ci removes and recreates the workspace node_modules directory. Review and save work before continuing.':'';
  const confirmation=await vscode.window.showWarningMessage('Run '+label+'?'+destructiveNotice+'\nNode: '+tools.node+'\nnpm CLI: '+tools.cli+'\nGlobal prefix: '+prefix+'\nPackage lifecycle scripts are DISABLED. All registry traffic uses Whale Bone localhost and approved registry.npmjs.org.',{modal:true},'Run npm');
  if(confirmation!=='Run npm')return;this.assertWorkspace(root);
  const controller=new AbortController();this.active=controller;this.operationRoot=root;let relayDir,relay;
  try{relayDir=N.registryCacheDir();
   this.output.show(true);this.output.appendLine('Operation: '+label+'\nNode: '+tools.node+'\nnpm CLI: '+tools.cli+'\nGlobal prefix: '+prefix+'\nMode: authenticated npm registry relay (scripts disabled)');
   const network=this.getNetwork?.()||{};
   await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Whale Bone npm: '+label,cancellable:true},async(progress,token)=>{
    const sub=token.onCancellationRequested?.(()=>controller.abort());try{
     this.assertWorkspace(root);relay=await N.startRelay({cacheDir:relayDir,extensionRoot:this.extensionRoot,signal:controller.signal,...network,onStatus:s=>{this.output.append(s);if(/FAILED|Retrying|Fetching/i.test(s))progress.report({message:s.replace(/^\[npm relay\] /,'').trim().slice(0,140)});}});
     progress.report({message:'Resolving npm packages through local registry…'});
     if(diagnostic){
      const pkg=N.parseCommand('npm install '+diagnostic).packages[0];
      progress.report({message:'Checking npm metadata and package tarball for '+pkg});
      const result=await N.probeRegistry(relay.url,pkg,{verifyTarball:true,signal:controller.signal});
      this.assertWorkspace(root);
      this.output.appendLine('npm registry test PASSED: '+result.name+'@'+result.version+
       '. Metadata '+result.metadataBytes+' bytes ('+result.metadataMs+'ms), tarball '+result.tarballBytes+
       ' bytes ('+result.tarballMs+'ms); integrity '+(result.integrityVerified?'verified':'not provided by registry')+'.');
      this.output.appendLine('Registry fetch counters: '+JSON.stringify(relay.requestStatus()));return;
     }
     const result=await N.runNpm({command,relayUrl:relay.url,tools,root,signal:controller.signal,onOutput:s=>this.output.append(s)});
     this.assertWorkspace(root);if(!command.global&&command.action==='install')await relay.restoreLockfile(root);
     if(['install','ci'].includes(command.action)){
      this.output.appendLine('Compatibility notice: npm lifecycle scripts are disabled. Packages requiring postinstall/prepare/native compilation may not function fully. Review scripts separately before permitting execution.');
      if(!command.global)for(const warning of N.lifecycleWarnings(root))this.output.appendLine('Compatibility notice: '+warning);
     }
     this.output.appendLine('npm completed: '+label+'\n'+JSON.stringify(relay.requestStatus()));return result;
    }finally{sub?.dispose?.();}
   });
   vscode.window.showInformationMessage('Whale Bone npm completed. '+(command?.global?'Global binaries: '+prefix:'See npm Packages output.'));
  }catch(e){if(relay)this.output.appendLine('npm relay diagnostic counters: '+JSON.stringify(relay.requestStatus()));this.output.appendLine('ERROR: '+String(e.message).slice(0,1200));void vscode.window.showErrorMessage('Whale Bone npm: '+String(e.message).slice(0,450));}
  finally{await relay?.close();this.active=null;this.operationRoot=null;}
 }
}
module.exports={NpmPackageUI};
