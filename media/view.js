'use strict';
(() => {
 const vscode=acquireVsCodeApi(),$=id=>document.getElementById(id),tabs=[...document.querySelectorAll('[data-tab]')],pages=['chat','files','tools','settings'];
 let state={},running=false,toastTimeout;
 const send=(type,more={})=>vscode.postMessage({type,...more});
 function showToast(message,error=false){const el=$('toast');el.textContent=String(message);el.classList.toggle('error',error);el.hidden=false;clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.hidden=true,8500);}
 function switchTab(name){for(const p of pages)$(p).hidden=p!==name;for(const t of tabs)t.classList.toggle('selected',t.dataset.tab===name);}
 tabs.forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));
 $('gear').onclick=()=>switchTab('settings');$('workspace').onclick=()=>send('workspace');$('chooseFolder').onclick=()=>send('workspace');$('attach').onclick=()=>send('attach');$('chooseFile').onclick=()=>send('attach');$('inlineEditButton').onclick=()=>send('inlineEdit');$('explainSelectionButton').onclick=()=>send('explainSelection');$('explainSelected').onclick=()=>send('explainSelection');$('reviewCode').onclick=()=>send('reviewCode');$('generateTests').onclick=()=>send('generateTests');$('toggleAutocomplete').onclick=()=>send('toggleAutocomplete');$('toggleAgentTools').onclick=()=>send('toggleAgentTools');$('apiConnector').onclick=()=>send('apiConnector');$('authorize').onclick=()=>send('authorize');$('selection').onclick=()=>send('attachSelection');
 $('new').onclick=()=>{if(!running)send('reset')};
 $('createSkill').onclick=()=>send('skill');$('chooseSkill').onclick=()=>send('chooseSkill');$('python').onclick=()=>send('installPython');$('packagesSettings').onclick=()=>send('pythonPackages');$('npmPackagesSettings').onclick=()=>send('npmPackages');$('maximizeLimits').onclick=()=>{if($('model').value.trim()!==state.settings?.model){showToast('Save your selected model before requesting its maximum limits.',true);return;}send('maximizeLimits');};$('setKey').onclick=()=>send('setKey');$('setProxyPassword').onclick=()=>send('setProxyPassword');$('proxyEnabled').onchange=updateProxyFields;$('proxyAuth').onchange=updateProxyFields;$('test').onclick=()=>send('test');$('models').onclick=()=>send('chooseModel');$('diagnostics').onclick=()=>send('diagnostics');$('troubleshoot').onclick=()=>send('troubleshoot');
 $('stop').onclick=()=>send('stop');
 $('send').onclick=()=>submit(false);$('compare').onclick=()=>submit(true);
 $('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit(false);}});
 document.querySelectorAll('[data-example]').forEach(b=>b.onclick=()=>{$('prompt').value=b.dataset.example;$('prompt').focus();});
 $('saveSettings').onclick=()=>{const keys=['baseUrl','proxyUrl','proxyAuth','proxyUsername','userAgent','authMode','model','comparisonModels','timeoutSeconds','outputTokens','contextWindowTokens'];const settings={proxyEnabled:$('proxyEnabled').checked,reviewOutbound:$('reviewOutbound').checked};for(const k of keys)settings[k]=$(k).value;send('saveSettings',{settings});};
 function submit(compare){let text=$('prompt').value.trim();if(!text||running)return;if(text.length>18000)return showToast('Message exceeds 18,000 characters',true);if(compare)send('compare',{text});else send('send',{text,mode:$('mode').value});$('prompt').value='';}
 function setRunning(active){running=active;$('send').disabled=active;$('compare').disabled=active;$('stop').hidden=!active;$('status').textContent=active?'Working…':'Ready';}
 function inlineMarkdown(parent,text){
  const tokens=String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  for(const token of tokens){
   if(!token)continue;
   if(token.startsWith('**')&&token.endsWith('**')&&token.length>4){const el=document.createElement('strong');el.textContent=token.slice(2,-2);parent.appendChild(el);}
   else if(token.startsWith('`')&&token.endsWith('`')&&token.length>2){const el=document.createElement('code');el.textContent=token.slice(1,-1);parent.appendChild(el);}
   else parent.appendChild(document.createTextNode(token));
  }
 }
 function proseMarkdown(parent,text){
  const lines=String(text).replace(/\r\n/g,'\n').split('\n');let paragraph=[],list=null;
  function flush(){if(!paragraph.length)return;const el=document.createElement('p');inlineMarkdown(el,paragraph.join('\n'));parent.appendChild(el);paragraph=[];}
  for(const line of lines){
   const heading=line.match(/^#{1,4}\s+(.+)$/),bullet=line.match(/^\s*[-*]\s+(.+)$/);
   if(heading){flush();list=null;const h=document.createElement('h3');inlineMarkdown(h,heading[1]);parent.appendChild(h);}
   else if(bullet){flush();if(!list){list=document.createElement('ul');parent.appendChild(list);}const li=document.createElement('li');inlineMarkdown(li,bullet[1]);list.appendChild(li);}
   else if(!line.trim()){flush();list=null;}
   else{list=null;paragraph.push(line);}
  }
  flush();
 }
 function formatted(parent,body){
  // Render a bounded Markdown subset using DOM text nodes only. No HTML or event-handler interpolation.
  const blocks=String(body||'').split(/(```[^\n]*\n[\s\S]*?```)/g);
  for(const block of blocks){
   const m=block.match(/^```([^\n]*)\n([\s\S]*?)```$/);
   if(m){const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=m[2];pre.appendChild(code);parent.appendChild(pre);}
   else if(block)proseMarkdown(parent,block);
  }
 }
 function appendMessage(role,text){const area=$('messages'),welcome=area.querySelector('.welcome');if(welcome)welcome.remove();const b=document.createElement('article');b.className='bubble '+(role==='user'?'user':'assistant');const top=document.createElement('div');top.className='who';top.textContent=role==='user'?'You':'Whale Bone';b.appendChild(top);const content=document.createElement('div');content.className='content';formatted(content,text);b.appendChild(content);area.appendChild(b);area.scrollTop=area.scrollHeight;}
 function updatePending(pending,lastApplied){const box=$('changes');box.replaceChildren();box.hidden=!(pending?.length||lastApplied?.path);if(box.hidden)return;
  if(pending?.length){const heading=document.createElement('h3');heading.textContent=`Review changes (${pending.length})`;box.appendChild(heading);
   pending.forEach(item=>{const c=document.createElement('div');c.className='change';const name=document.createElement('b');name.textContent=(item.newFile?'New file: ':'Edit: ')+item.path;c.appendChild(name);if(item.summary){const p=document.createElement('p');p.textContent=item.summary;c.appendChild(p)}const actions=document.createElement('div');actions.className='actions';
    const preview=document.createElement('button');preview.textContent=item.previewed?'View diff again':'View diff';preview.onclick=()=>send('preview',{id:item.id});
    const apply=document.createElement('button');apply.textContent='Apply and open file';apply.className='primary';apply.disabled=!item.previewed||running;apply.title='Save the approved change into the workspace and open the real file';apply.onclick=()=>send('apply',{id:item.id});
    const reject=document.createElement('button');reject.textContent='Reject';reject.onclick=()=>send('reject',{id:item.id});actions.append(preview,apply,reject);c.appendChild(actions);box.appendChild(c);});}
  if(lastApplied?.path){const applied=document.createElement('div');applied.className='saved-change';const label=document.createElement('span');label.textContent='Saved to workspace: '+lastApplied.path;const open=document.createElement('button');open.textContent='Open final file';open.onclick=()=>send('openAppliedFile');applied.append(label,open);box.appendChild(applied);}
 }
 function updateFiles(data){$('folderName').textContent=data.workspace?.path||'No workspace selected';$('skillStatus').textContent=data.skill?'Active skill: '+data.skill:'No skill selected';const list=$('attachedList');list.replaceChildren();for(const [i,item] of (data.attached||[]).entries()){const div=document.createElement('div');div.className='filechip';const label=document.createElement('span');label.textContent=item.path+(item.selection?`:${item.selection.start}-${item.selection.end}`:'');const x=document.createElement('button');x.textContent='×';x.title='Remove attachment';x.onclick=()=>send('detach',{index:i});div.append(label,x);list.appendChild(div);}
  $('selection').textContent=data.selectionScope?'Selection ON ×':'@ Selection';$('selection').title=data.selectionScope?`Selected scope: ${data.selectionScope.path}, lines ${data.selectionScope.start}-${data.selectionScope.end}. Click to clear.`:'Lock editor selection for the next Ask/Plan/Build request';const label=data.workspace?.name||'Choose workspace';$('workspace').textContent='⌂ '+label;$('workspace').title=data.workspace?.path||'Choose a workspace folder';const parts=[];if(data.selectionScope)parts.push('Scoped selection: '+data.selectionScope.path+':'+data.selectionScope.start+'-'+data.selectionScope.end);else if(data.active?.path)parts.push('Active: '+data.active.path+(data.active.selection?`:${data.active.selection.start}-${data.active.selection.end}`:''));if(data.attached?.length)parts.push(data.attached.length+' attached');if(data.workspace&&!data.trust)parts.push('Untrusted');if(data.workspace&&!data.consent)parts.push('Needs data consent');$('contextBadge').textContent=parts.join(' · ')||'Select a workspace or ask a general question';}
 function updateSettings(cfg){$('proxyEnabled').checked=cfg?.proxyEnabled!==false;$('reviewOutbound').checked=!!cfg?.reviewOutbound;for(const k of ['baseUrl','proxyUrl','proxyAuth','proxyUsername','authMode','userAgent','model','comparisonModels','timeoutSeconds','outputTokens','contextWindowTokens']){const el=$(k);if(el&&document.activeElement!==el)el.value=cfg?.[k]??'';}}
 function updateProxyFields(){const on=$('proxyEnabled').checked,user=on&&$('proxyAuth').value==='user';$('proxyUrl').disabled=!on;$('proxyAuth').disabled=!on;$('proxyUsername').disabled=!user;$('setProxyPassword').disabled=!user;$('proxyPasswordStatus').hidden=!user;$('proxyPasswordStatus').textContent=state.proxyPasswordSet?'Proxy password is saved.':'No proxy password saved yet.';}
 function update(s){state=s||{};
  let banner=$('configurationWarning');if(!banner){banner=document.createElement('p');banner.id='configurationWarning';banner.setAttribute('role','alert');banner.className='muted';$('settings').prepend(banner);}
  banner.hidden=!state.configurationError;banner.textContent=state.configurationError?'Settings need attention: '+state.configurationError+'. Correct the values below and select Save settings.':'';if($('toggleAutocomplete'))$('toggleAutocomplete').textContent='Tab autocomplete: '+(state.settings?.reviewOutbound?'PAUSED (context review)':state.features?.autocomplete?'ON':'OFF');if($('toggleAgentTools'))$('toggleAgentTools').textContent='Approved test tools: '+(state.features?.agentTools==='approved-tests'?'ON':'OFF');updateFiles(state);updatePending(state.pending,state.lastApplied);updateSettings(state.settings);updateProxyFields();setRunning(!!state.running);}
 window.addEventListener('message',ev=>{const m=ev.data;if(!m||typeof m.type!=='string')return;
  switch(m.type){case 'state':update(m.state);break;
   case 'context':state.active=m.active||null;updateFiles(state);break;
   case 'chat':appendMessage(m.role,m.text);break;
   case 'replay':{const area=$('messages');area.replaceChildren();for(const entry of (m.messages||[]).slice(-80))if(entry.type==='chat')appendMessage(entry.role,entry.text);break;}
   case 'error':showToast(m.message,true);$('status').textContent='Error';break;
   case 'notice':showToast(m.message,false);break;
   case 'progress':$('status').textContent=String(m.event?.message||'Working…').slice(0,70);if(m.event?.kind==='tool'){const e=document.createElement('div');e.className='activity';e.textContent='↳ '+m.event.message;$('messages').appendChild(e);$('messages').scrollTop=$('messages').scrollHeight;}break;
   case 'busy':setRunning(m.running);break;
   case 'clear':$('messages').replaceChildren();appendMessage('assistant','New conversation. What would you like to work on?');break;
   case 'models':showToast((m.models||[]).length+' model(s) available. Use Choose model in Settings.');break;
  }
 });
 send('ready');
})();
