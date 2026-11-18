'use strict';
/** Native VS Code Python package manager. All choices remain in VS Code; no extra service to install. */
const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const P=require('./python-packages');
class PythonPackageUI{
 constructor(vscode,{getRoot,getNetwork,extensionRoot}){
  this.vscode=vscode;this.getRoot=getRoot;this.getNetwork=getNetwork;this.extensionRoot=extensionRoot;
  this.selected=new Map();this.active=null;this.output=vscode.window.createOutputChannel('Whale Bone: Python Packages');
 }
 dispose(){this.active?.abort();this.output.dispose?.();}
 notifyError(e){let raw=String(e?.message||e).slice(0,450);let tip='';
  if(/407|proxy|authentication/i.test(raw))tip=' Verify your Windows sign-in, enterprise proxy and approved browser User-Agent.';
  else if(/403|Forbidden/i.test(raw))tip=' This host or User-Agent may not be allowed by your corporate proxy.';
  else if(/certificate|SSL|TLS/i.test(raw))tip=' Check the Windows trust store for your organization’s inspection certificate. Certificate verification has not been disabled.';
  else if(/no matching distribution|Could not find a version/i.test(raw))tip=' The selected package index may be unavailable or have no compatible wheels. Use Test package index via proxy to check the actual upstream response.';
  this.output.appendLine('ERROR: '+raw+tip);void this.vscode.window.showErrorMessage('Whale Bone Python Packages: '+raw+tip);
 }
 assertWorkspace(root){
  const current=this.getRoot?.()??this.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if(!root||current!==root)throw Error('Selected Python workspace changed. Reopen Python Packages for the current workspace.');
  if(this.vscode.workspace.isTrusted===false)throw Error('Workspace trust was revoked. Python operation cancelled.');
  if(this.vscode.workspace.workspaceFolders?.length&&!this.vscode.workspace.workspaceFolders.some(f=>f.uri.fsPath===root))throw Error('Selected Python workspace was removed.');
 }
 async root(){const root=this.getRoot?.()||this.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;if(!root)throw Error('Open a project folder in VS Code first');return root;}
 async selectedInterpreter(root){const old=this.selected.get(root);if(old&&fs.existsSync(old))return P.resolvedInterpreter(old);
  const python=this.vscode.extensions?.getExtension?.('ms-python.python');let active='';
  try{const p=python?.exports?.environments?.getActiveEnvironmentPath?.(this.vscode.Uri.file(root));active=typeof p==='string'?p:p?.path||'';}catch{}
  const configured=this.vscode.workspace.getConfiguration('python').get('defaultInterpreterPath','');
  const paths=P.candidateInterpreters(root,{active,configured}).filter(x=>fs.existsSync(x)&&fs.statSync(x).isFile());
  const choices=paths.map((p,i)=>({label:(i===0?'$(check) ':'$(terminal) ')+path.basename(p),description:p,value:p}));
  choices.push({label:'$(folder-opened) Browse for Python executable...',description:'Select python.exe or a workspace virtual environment',browse:true});
  const selection=await this.vscode.window.showQuickPick(choices,{title:'Python environment',placeHolder:'Choose where Python packages will be installed',ignoreFocusOut:true});
  if(!selection)return null;
  let candidate=selection.value;
  if(selection.browse){const selected=await this.vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,canSelectMany:false,openLabel:'Select Python interpreter'});candidate=selected?.[0]?.fsPath;}
  if(!candidate)return null;this.assertWorkspace(root);candidate=P.resolvedInterpreter(candidate);this.selected.set(root,candidate);return candidate;
 }
 async inspect(interpreter,root){const script='import sys,json;print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"virtual":sys.prefix!=sys.base_prefix}))';
  const result=await P.runProcess(interpreter,['-c',script],{cwd:root,timeoutMs:20000});
  try{return JSON.parse(result.stdout.trim());}catch{throw Error('Selected executable did not return valid Python environment information');}
 }
 async inputPackage(title){const text=await this.vscode.window.showInputBox({title,prompt:'Package name with optional version, for example requests==2.32.0',placeHolder:'requests',ignoreFocusOut:true,validateInput:v=>{try{P.validatePackage(v);return undefined;}catch(e){return e.message;}}});return text===undefined?null:P.validatePackage(text);}
 async execute({root,interpreter,action,packages,requirementsText,offline=false,wheelhouse,userSite=false}){
  this.assertWorkspace(root);if(this.active)throw Error('A Python package operation is running. Cancel it before starting another.');
  const controller=new AbortController();this.active=controller;
  try{
   this.assertWorkspace(root);const network=this.getNetwork();const args={interpreter,root,action,packages,requirementsText,offline,wheelhouse,userSite,proxyUrl:network.proxyUrl,proxy:network.proxy,userAgent:network.userAgent,extensionRoot:this.extensionRoot,signal:controller.signal,onOutput:s=>this.output.append(String(s).slice(0,5000))};
   this.output.appendLine('Operation: '+action+' ('+packages.length+' requirement'+(packages.length===1?'':'s')+')'+(packages.length<=5?' '+packages.join(', '):' [see selected requirements file]')+'\nInterpreter: '+interpreter+'\nMode: '+(offline?'offline wheel cache':'authenticated PyPI relay'));
   this.output.show(true);
   const result=await this.vscode.window.withProgress({location:this.vscode.ProgressLocation.Notification,title:'Whale Bone: Python '+action,cancellable:true},async(progress,token)=>{
    const disposable=token.onCancellationRequested?.(()=>controller.abort());
    try{this.assertWorkspace(root);progress.report({message:'Resolving packages and dependencies…'});const result=await P.runPip(args);this.assertWorkspace(root);return result;}finally{disposable?.dispose?.();}
   });
   this.output.appendLine('Completed successfully.');
   void this.vscode.window.showInformationMessage('Python '+action+' completed. See Whale Bone: Python Packages output for details.');
   return result;
  }catch(e){this.notifyError(e);return null;}
  finally{this.active=null;}
 }
 async diagnostic(root,project='pip'){this.assertWorkspace(root);if(this.active)throw Error('Another Python operation is running');const control=new AbortController();this.active=control;let relay=null;
  try{const network=this.getNetwork();const temp=await fsp.mkdtemp(path.join(require('node:os').tmpdir(),'whalebone-py-check-'));
   try{relay=await P.startRelay({...network,extensionRoot:this.extensionRoot,cacheDir:temp,signal:control.signal});const response=await new Promise((resolve,reject)=>{http.get(relay.indexUrl+encodeURIComponent(project)+'/',r=>{let body='';r.on('data',d=>body=(body+String(d)).slice(0,200000));r.on('end',()=>resolve({status:r.statusCode,body}));}).on('error',reject);});if(response.status!==200)throw Error('PyPI index for '+project+' returned HTTP '+response.status+': '+response.body.slice(0,260).replace(/\s+/g,' '));
    if(!/\/files\/[a-f0-9]{64}\//.test(response.body))throw Error('The PyPI index for '+project+' did not return package file links. Check proxy authentication, User-Agent filtering or proxy login interception.');
    this.assertWorkspace(root);const stat=relay.indexStatus()[project.toLowerCase().replace(/[-_.]+/g,'-')];
    const count=stat?.links||'some';this.output.appendLine('Relay request counts: '+JSON.stringify(relay.requestStatus()));
    this.output.appendLine('PyPI package index reachable: '+project+' ('+count+' artifact links). This validates metadata access only; wheel downloads and platform compatibility are not yet verified.');
    void this.vscode.window.showInformationMessage('PyPI index for '+project+' is reachable ('+count+' files listed). Wheel compatibility and downloads are checked during installation.');
   }finally{await relay?.close();await fsp.rm(temp,{recursive:true,force:true}).catch(()=>{});}
  }catch(e){this.notifyError(e);}finally{this.active=null;}
 }
 async open(){try{
  if(this.vscode.workspace.isTrusted===false)throw Error('Trust the workspace in VS Code before installing Python packages.');
  const root=await this.root();if(this.active){void this.vscode.window.showInformationMessage('A Python package operation is active. Use Cancel in its progress notification.');return;}
  const choices=[
   {label:'$(add) Install a package',action:'install',description:'Install a package and its compatible dependencies'},
   {label:'$(arrow-up) Upgrade a package',action:'upgrade',description:'Upgrade a selected package'},
   {label:'$(list-unordered) Installed packages',action:'list',description:'Browse, upgrade or uninstall packages'},
   {label:'$(file-code) Install requirements.txt',action:'requirements',description:'PEP 508 markers, SHA-256 hashes and workspace-local -r includes'},
   {label:'$(cloud-download) Download wheels for offline use',action:'download',description:'Cache a package and dependencies inside .whalebone/wheels'},
   {label:'$(package) Install from offline wheel cache',action:'offline',description:'Install without internet connectivity'},
   {label:'$(folder-library) Create workspace .venv',action:'venv',description:'Recommended isolated environment, no administrator rights'},
   {label:'$(debug) Test Python localhost relay',action:'loopback',description:'Confirm the selected Python 3.13 process can reach 127.0.0.1 without an external proxy'},
   {label:'$(debug) Test authenticated PyPI connectivity',action:'diagnose',description:'Check the pip package index through the authenticated proxy'},
   {label:'$(search) Test package index via proxy',action:'diagnosePackage',description:'Check metadata access for a specific package (for example pandas)'},
   {label:'$(terminal) Choose Python interpreter',action:'choose',description:this.selected.get(root)||'Select an interpreter'}
  ];
  const selection=await this.vscode.window.showQuickPick(choices,{title:'Whale Bone · Python Packages',placeHolder:'Choose an action',ignoreFocusOut:true});if(!selection)return;
  this.assertWorkspace(root);
  if(selection.action==='loopback'){
   const interpreter=await this.selectedInterpreter(root);if(!interpreter)return;this.assertWorkspace(root);
   if(this.active)throw Error('Another Python package operation is running');
   const control=new AbortController();this.active=control;let relay=null;
   const temp=await fsp.mkdtemp(path.join(require('node:os').tmpdir(),'whalebone-loopback-check-'));
   try{
    relay=await P.startRelay({...this.getNetwork(),extensionRoot:this.extensionRoot,cacheDir:temp,signal:control.signal});
    this.assertWorkspace(root);await P.probePythonLoopback({interpreter,root,indexUrl:relay.indexUrl,signal:control.signal});
    this.output.appendLine('PASS: selected Python interpreter reached the local relay directly: '+interpreter);
    this.output.show(true);
    void this.vscode.window.showInformationMessage('Python localhost relay reachable. Run Test package index via proxy to check upstream PyPI.');
   }catch(e){this.notifyError(e);}
   finally{await relay?.close();await fsp.rm(temp,{recursive:true,force:true}).catch(()=>{});this.active=null;}
   return;
  }
  if(selection.action==='diagnose'){await this.diagnostic(root);return;}
  if(selection.action==='diagnosePackage'){const spec=await this.inputPackage('Package index to diagnose (version optional)');if(!spec)return;const project=spec.match(/^[a-zA-Z0-9._-]+/)[0];await this.diagnostic(root,project);return;}
  if(selection.action==='choose'){this.selected.delete(root);await this.selectedInterpreter(root);return;}
  if(selection.action==='venv'){
   const dest=path.join(root,'.venv');if(fs.existsSync(dest))throw Error('The .venv folder already exists. Select it as your interpreter.');
   const python=await this.selectedInterpreter(root);if(!python)return;this.assertWorkspace(root);
   const yes=await this.vscode.window.showInformationMessage('Create a Python virtual environment in '+dest+'?',{modal:true},'Create .venv');if(yes!=='Create .venv')return;this.assertWorkspace(root);
   const controller=new AbortController();this.active=controller;
   try{const result=await P.runProcess(python,['-m','venv',dest],{cwd:root,signal:controller.signal,timeoutMs:120000,onOutput:s=>this.output.append(s)});
    this.assertWorkspace(root);if(controller.signal.aborted)throw Error('Python workspace operation cancelled.');
    this.output.appendLine(result.stdout);const created=path.join(dest,process.platform==='win32'?'Scripts/python.exe':'bin/python');this.selected.set(root,created);
    void this.vscode.window.showInformationMessage('Workspace .venv created. Packages will install there.');return;
   }finally{if(this.active===controller)this.active=null;}
  }
  const interpreter=await this.selectedInterpreter(root);if(!interpreter)return;
  this.assertWorkspace(root);const details=await this.inspect(interpreter,root);this.assertWorkspace(root);
  if(selection.action==='list'){
   const controller=new AbortController();this.active=controller;let installed;
   try{installed=await P.runPip({interpreter,root,action:'list',signal:controller.signal});this.assertWorkspace(root);if(controller.signal.aborted)throw Error('Python package listing cancelled.');}
   finally{if(this.active===controller)this.active=null;}
   let items;try{items=JSON.parse(installed.stdout).map(p=>({label:p.name,description:p.version}));}catch{throw Error('Could not parse pip list results');}
   const p=await this.vscode.window.showQuickPick(items,{title:'Installed packages · '+details.version,placeHolder:'Select a package to upgrade or uninstall'});if(!p)return;this.assertWorkspace(root);
   const next=await this.vscode.window.showQuickPick([{label:'$(arrow-up) Upgrade '+p.label,action:'upgrade'},{label:'$(trash) Uninstall '+p.label,action:'uninstall'}],{title:p.label+' '+p.description});if(!next)return;this.assertWorkspace(root);
   if(next.action==='uninstall'){const yes=await this.vscode.window.showWarningMessage('Uninstall '+p.label+' from '+details.executable+'?',{modal:true},'Uninstall');if(yes!=='Uninstall')return;this.assertWorkspace(root);}
   return this.execute({root,interpreter,action:next.action,packages:[P.validatePackage(p.label)],userSite:!details.virtual});
  }
  let packages=[],requirementsText;
  if(selection.action==='requirements'){
   const chosen=await this.vscode.window.showOpenDialog({defaultUri:this.vscode.Uri.file(root),canSelectFiles:true,canSelectFolders:false,canSelectMany:false,openLabel:'Choose requirements.txt'});if(!chosen?.[0])return;
   const target=chosen[0].fsPath,rel=path.relative(root,target);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Requirements file must be inside the workspace');
   const imported=P.parseRequirementsFile(target,root);
   const hashNotice=P.requirementsHashWarning(imported);
   if(hashNotice){this.output.appendLine(hashNotice);if(imported.unhashedCount)throw Error(hashNotice);}
   packages=imported.packages;requirementsText=imported.text;
   if(hashNotice)this.output.appendLine('Hash checking also applies to transitive dependencies.');
   this.output.appendLine('Validated '+packages.length+' requirements from '+imported.files.length+' workspace file(s). SHA-256 hashes, if provided, remain enforced by pip.');
  }else{const pkg=await this.inputPackage(selection.action==='download'?'Download Python wheel':'Python package');if(!pkg)return;packages=[pkg];}
  const offline=selection.action==='offline';let wheelhouse;
  if(offline||selection.action==='download'){
   wheelhouse=P.validateWheelhouse(root);if(offline){if(!fs.existsSync(wheelhouse))throw Error('No cached wheels. Select Download wheels for offline use first.');}
   else await fsp.mkdir(wheelhouse,{recursive:true});
  }
  const action=selection.action==='requirements'||offline?'install':selection.action;
  const target=details.virtual?'virtual environment':'per-user Python site-packages';
  const summary=selection.action==='requirements'?packages.length+' requirements from the selected requirements file':packages.join(', ').slice(0,180);
  const confirmation=await this.vscode.window.showInformationMessage(action+' '+summary+' into '+target+' ('+details.version+')?',{modal:true},'Continue');if(confirmation!=='Continue')return;
  this.assertWorkspace(root);await this.execute({root,interpreter,action,packages,requirementsText,offline,wheelhouse,userSite:!details.virtual});
 }catch(e){this.notifyError(e);}}
}
module.exports={PythonPackageUI};
