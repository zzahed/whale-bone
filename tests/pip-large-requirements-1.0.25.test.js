'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const R=require('../src/requirements'),P=require('../src/python-packages');
function withDir(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb125-req-'));try{return fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('imports more than 300 requirements across nested local files with markers, comments and hashes',()=>withDir(root=>{
 const digest='a'.repeat(64);
 fs.writeFileSync(path.join(root,'root.txt'),'# Import > 300 distinct names\n'+Array.from({length:310},(_,i)=>'wb-demo-'+String(i).padStart(4,'0')+'==1.0\n').join('')+'-r extra.txt\n');
 fs.writeFileSync(path.join(root,'extra.txt'),Array.from({length:230},(_,i)=>'wb-extra-'+String(i).padStart(4,'0')+'==2.0; python_version >= "3.11"\n').join('')+'wb-secure==1.0 --hash=sha256:'+digest+'\n');
 const parsed=R.parseRequirementsFile(path.join(root,'root.txt'),root);
 assert.equal(parsed.packages.length,541);
 assert.equal(parsed.files.length,2);assert.match(parsed.text,/wb-secure==1\.0 --hash=sha256:/);
 assert.ok(P.pipArgs('install',parsed.packages,{indexUrl:'http://127.0.0.1:1555/simple/',requirementsFile:path.join(root,'validated.txt')}).includes('--requirement'));
 assert.throws(()=>P.pipArgs('install',parsed.packages,{indexUrl:'http://127.0.0.1:1555/simple/'}),/120/);
}));
test('rejects unsafe pip directives in large requirements and bounds excessive entries',()=>withDir(root=>{
 fs.writeFileSync(path.join(root,'unsafe.txt'),Array.from({length:340},(_,i)=>'wb-safe-'+i+'==1.0').join('\n')+'\n--extra-index-url https://attacker.invalid/simple\n');
 assert.throws(()=>R.parseRequirementsFile(path.join(root,'unsafe.txt'),root),/unsafe\.txt:341:.*Unsupported pip option/);
 fs.writeFileSync(path.join(root,'huge.txt'),Array.from({length:5100},(_,i)=>'wb-safe-'+i+'==1.0').join('\n'));
 assert.throws(()=>R.parseRequirementsFile(path.join(root,'huge.txt'),root),/limit|exceeds|maximum/i);
}));
test('pip diagnostic singles out actual missing requirement rather than blaming the complete manifest',()=>{
 const stderr='ERROR: Could not find a version that satisfies the requirement wb-bad==9.9 (from versions: none)\nERROR: No matching distribution found for wb-bad==9.9\n';
 const report=P.pipResolutionDiagnostic(stderr,{ 'wb-good':{links:100},'wb-bad':{links:3} },541);
 assert.match(report,/wb-bad==9\.9/);assert.match(report,/541/);
 assert.doesNotMatch(report,/wb-good/);assert.match(report,/wheel|version|architecture/i);
});

test('large requirements use a bounded, longer pip operation deadline',()=>{
 assert.equal(P.pipOperationTimeoutMs(1),35*60*1000);
 assert.ok(P.pipOperationTimeoutMs(541)>35*60*1000);
 assert.ok(P.pipOperationTimeoutMs(5000)<=120*60*1000);
});

test('real pip installs a hashed wheel from a 320-line imported requirements file', {skip:!process.env.PYTHON_FOR_TESTS},async()=>{
 const fsp=require('node:fs/promises'),cp=require('node:child_process'),crypto=require('node:crypto');
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'wb125-pip-'));
 try{
  const py=process.env.PYTHON_FOR_TESTS,venv=path.join(root,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const creation=cp.spawnSync(py,['-m','venv',path.dirname(path.dirname(venv))],{encoding:'utf8',timeout:90000});
  assert.equal(creation.status,0,creation.stderr);
  const wheel=path.join(root,'wb_many_reqs-1.0.0-py3-none-any.whl');
  const make=String.raw`import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('wb_many_reqs/__init__.py','VERSION="1.0.0"\n')
 z.writestr('wb_many_reqs-1.0.0.dist-info/METADATA','Metadata-Version: 2.1\nName: wb-many-reqs\nVersion: 1.0.0\n')
 z.writestr('wb_many_reqs-1.0.0.dist-info/WHEEL','Wheel-Version: 1.0\nGenerator: wb-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
 z.writestr('wb_many_reqs-1.0.0.dist-info/RECORD','')`;
  assert.equal(cp.spawnSync(py,['-c',make,wheel],{encoding:'utf8'}).status,0);
  const digest=crypto.createHash('sha256').update(await fsp.readFile(wheel)).digest('hex');
  await fsp.writeFile(path.join(root,'req.txt'),Array.from({length:320},()=>`wb-many-reqs==1.0.0 --hash=sha256:${digest}`).join('\n')+'\n');
  const parsed=P.parseRequirementsFile(path.join(root,'req.txt'),root);assert.equal(parsed.packages.length,320);
  const url='https://files.pythonhosted.org/packages/example/wb_many_reqs-1.0.0-py3-none-any.whl';
  const fetchFile=async(u,dest)=>{
   if(u==='https://pypi.org/simple/wb-many-reqs/')await fsp.writeFile(dest,`<a href="${url}#sha256=${digest}">wb_many_reqs-1.0.0-py3-none-any.whl</a>`);
   else if(u===url)await fsp.copyFile(wheel,dest);
   else throw Error('Unexpected URL '+u);
  };
  const result=await P.runPip({interpreter:venv,root,action:'install',packages:parsed.packages,requirementsText:parsed.text,fetchFile});
  assert.equal(result.code,0);assert.match(result.stdout,/Successfully installed/);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
