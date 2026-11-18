'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const R=require('../src/requirements'),W=require('../src/workspace'),P=require('../src/python-packages');
function temp(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb126-req-'));try{return fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
function requirementFile(root,size,name='requirements.txt'){
 const last='wb-valid==1.0\n';const padding=size-Buffer.byteLength(last);
 if(padding<3)throw Error('insufficient size');
 const text='#'+'x'.repeat(padding-2)+'\n'+last;
 assert.equal(Buffer.byteLength(text),size);
 const f=path.join(root,name);fs.writeFileSync(f,text);return f;
}
test('requirements importer accepts 150KB, 151KB, 500KB and 1MiB without changing generic AI-read cap',()=>temp(root=>{
 for(const size of [150_000,150_001,500_000,1024*1024]){
  const file=requirementFile(root,size);
  const imported=R.parseRequirementsFile(file,root);
  assert.deepEqual(imported.packages,['wb-valid==1.0']);
  if(size>W.MAX_FILE)assert.throws(()=>W.read(root,file),/150 KB limit/);
 }
 const tooBig=requirementFile(root,1024*1024+1);
 assert.throws(()=>R.parseRequirementsFile(tooBig,root),/1 MiB|limit|exceeds/);
}));
test('large requirements preserve 5000 distinct package names up to the 1 MiB source limit',()=>temp(root=>{
 const entries=Array.from({length:5000},(_,i)=>'wb-distinct-'+String(i).padStart(4,'0')+'==1.0');
 const text=entries.join('\n')+'\n';
 const padded=text+'#'+'z'.repeat(500000-text.length-2)+'\n';
 const file=path.join(root,'requirements.txt');fs.writeFileSync(file,padded);
 assert.equal(fs.statSync(file).size,500000);
 const parsed=R.parseRequirementsFile(file,root);
 assert.equal(parsed.packages.length,5000);
 assert.equal(new Set(parsed.packages).size,5000);
}));
test('requirements importer still rejects links, protected paths, and oversized aggregate includes',()=>temp(root=>{
 const external=fs.mkdtempSync(path.join(os.tmpdir(),'wb126-outside-'));
 try{
  const safe=requirementFile(root,200_000,'safe.txt');
  const link=path.join(root,'linked.txt');fs.linkSync(safe,link);
  assert.throws(()=>R.parseRequirementsFile(link,root),/Hard-linked/);
  const symlink=path.join(root,'symlink.txt');fs.symlinkSync(safe,symlink);
  assert.throws(()=>R.parseRequirementsFile(symlink,root),/Symbolic link/);
  const protectedFile=requirementFile(root,200_000,'.env');
  assert.throws(()=>R.parseRequirementsFile(protectedFile,root),/Protected/);
  const outside=requirementFile(external,200_000,'outside.txt');
  assert.throws(()=>R.parseRequirementsFile(outside,root),/outside|escapes/);
  const part=requirementFile(root,800_000,'a.txt');const part2=requirementFile(root,800_000,'b.txt');const part3=requirementFile(root,800_000,'c.txt');
  fs.writeFileSync(path.join(root,'root.txt'),'-r a.txt\n-r b.txt\n-r c.txt\n');
  assert.throws(()=>R.parseRequirementsFile(path.join(root,'root.txt'),root),/2 MiB/);
 }finally{fs.rmSync(external,{recursive:true,force:true});}
}));
test('hashed requirements expose incomplete hash coverage before invoking pip',()=>temp(root=>{
 const content='wb-a==1.0 --hash=sha256:'+ 'a'.repeat(64)+'\nwb-b==2.0\n';
 const file=path.join(root,'requirements.txt');fs.writeFileSync(file,content);
 const parsed=R.parseRequirementsFile(file,root);
 assert.equal(parsed.hasHashes,true);
 assert.equal(parsed.unhashedCount,1);
 assert.match(P.requirementsHashWarning(parsed),/1.*unhashed|unhashed.*1|one.*without/i);
}));

test('real pip resolves 305 distinct hashed wheels from a >150KB requirements file', {skip:!process.env.PYTHON_FOR_TESTS},async()=>{
 const fsp=require('node:fs/promises'),cp=require('node:child_process'),crypto=require('node:crypto');
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wb126-many-distinct-'));
 try{
  const py=process.env.PYTHON_FOR_TESTS,envDir=path.join(root,'venv');
  const venv=path.join(envDir,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const created=cp.spawnSync(py,['-m','venv',envDir],{encoding:'utf8',timeout:90000});
  assert.equal(created.status,0,created.stderr);
  const wheels=path.join(root,'test-wheels');await fsp.mkdir(wheels);
  const generate=String.raw`import pathlib,sys,zipfile
folder=pathlib.Path(sys.argv[1]); count=int(sys.argv[2])
for i in range(count):
 name=f'wb_distinct_{i:04d}'; project=f'wb-distinct-{i:04d}'
 filename=folder / f'{name}-1.0.0-py3-none-any.whl'
 with zipfile.ZipFile(filename,'w',zipfile.ZIP_DEFLATED) as z:
  z.writestr(f'{name}/__init__.py','VALUE=1\n')
  z.writestr(f'{name}-1.0.0.dist-info/METADATA',f'Metadata-Version: 2.1\nName: {project}\nVersion: 1.0.0\n')
  z.writestr(f'{name}-1.0.0.dist-info/WHEEL','Wheel-Version: 1.0\nGenerator: wb-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
  z.writestr(f'{name}-1.0.0.dist-info/RECORD','')`;
  const generated=cp.spawnSync(py,['-c',generate,wheels,'305'],{encoding:'utf8',timeout:30000});
  assert.equal(generated.status,0,generated.stderr);
  const hashes=new Map(),lines=[];
  for(let i=0;i<305;i++){
   const suffix=String(i).padStart(4,'0');const name='wb-distinct-'+suffix;
   const fname='wb_distinct_'+suffix+'-1.0.0-py3-none-any.whl';
   hashes.set(name,{fname,sha:crypto.createHash('sha256').update(await fsp.readFile(path.join(wheels,fname))).digest('hex')});
   lines.push(name+'==1.0.0 --hash=sha256:'+hashes.get(name).sha);
  }
  // Make the source large enough to exercise the special 1 MiB policy.
  const head=lines.join('\n')+'\n';
  const requirementsFile=path.join(root,'requirements.txt');
  await fsp.writeFile(requirementsFile,head+'#'+'a'.repeat(200_000-head.length-2)+'\n');
  assert.ok((await fsp.stat(requirementsFile)).size>150_000);
  const parsed=R.parseRequirementsFile(requirementsFile,root);
  assert.equal(parsed.packages.length,305);assert.equal(parsed.unhashedCount,0);
  const seenIndices=new Set(),seenWheels=new Set();
  const fetchFile=async(url,dest)=>{
   const parsedUrl=new URL(url),parts=parsedUrl.pathname.split('/').filter(Boolean);
   if(parts[0]==='simple'&&parts.length===2){
    const name=parts[1];const item=hashes.get(name);if(!item)throw Error('Unexpected index '+url);
    seenIndices.add(name);
    await fsp.writeFile(dest,`<a href="https://files.pythonhosted.org/packages/test/${item.fname}#sha256=${item.sha}">${item.fname}</a>`);
   }else if(parsedUrl.hostname==='files.pythonhosted.org'){
    const filename=path.basename(parsedUrl.pathname);seenWheels.add(filename);await fsp.copyFile(path.join(wheels,filename),dest);
   }else throw Error('Unexpected upstream '+url);
  };
  const result=await P.runPip({interpreter:venv,root,action:'install',packages:parsed.packages,requirementsText:parsed.text,fetchFile});
  assert.equal(result.code,0,result.stderr);
  assert.equal(seenIndices.size,305);
  assert.equal(seenWheels.size,305);
  const installed=cp.spawnSync(venv,['-c','import wb_distinct_0000, wb_distinct_0304; print(wb_distinct_0000.VALUE+wb_distinct_0304.VALUE)'],{encoding:'utf8'});
  assert.equal(installed.status,0,installed.stderr);
  assert.match(installed.stdout,/2/);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('SHA-256 hashes require an exact single pinned version, not a wildcard or range',()=>temp(root=>{
 const hash=' --hash=sha256:'+ 'a'.repeat(64);
 for(const spec of ['wb-example==1.*','wb-example>=1.0','wb-example==1.0,!=1.0']){
  const filename=path.join(root,'requirements.txt');fs.writeFileSync(filename,spec+hash+'\n');
  assert.throws(()=>R.parseRequirementsFile(filename,root),/exact|pin|hash/i,spec);
 }
 const file=path.join(root,'requirements.txt');
 fs.writeFileSync(file,'wb-example[extra]==1.2.3; python_version >= "3.11"'+hash+'\n');
 assert.equal(R.parseRequirementsFile(file,root).unhashedCount,0);
}));

test('pip runner rejects incomplete hash mode before opening any relay connection', {skip:!process.env.PYTHON_FOR_TESTS},async()=>{
 const fsp=require('node:fs/promises');const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wb126-hash-'));
 try{
  const file=path.join(root,'requirements.txt');await fsp.writeFile(file,'wb-a==1.0 --hash=sha256:'+'a'.repeat(64)+'\nwb-b==2.0\n');
  const parsed=R.parseRequirementsFile(file,root);let upstreamCalls=0;
  await assert.rejects(()=>P.runPip({interpreter:process.env.PYTHON_FOR_TESTS,root,action:'install',packages:parsed.packages,requirementsText:parsed.text,fetchFile:async()=>{upstreamCalls++;}}),/Incomplete SHA-256 hash mode/);
  assert.equal(upstreamCalls,0);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('requirements-only validation rejects a missing file before parsing',()=>temp(root=>{
 assert.throws(()=>W.checkFile(root,'missing-req.txt','requirements'),/File does not exist/);
}));
