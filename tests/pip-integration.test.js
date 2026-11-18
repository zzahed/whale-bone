'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const P=require('../src/python-packages');
// Integration testing is opt-in, because it creates a temporary Python 3.13 venv.
const PYTHON=process.env.PYTHON_FOR_TESTS;
test('pip 3.13 installs a SHA-256-pinned wheel over the real localhost index', {skip:!PYTHON},async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'wb-pip-integration-'));
 try{
  const envdir=path.join(dir,'venv'),venv=path.join(envdir,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const created=cp.spawnSync(PYTHON,['-m','venv',envdir],{encoding:'utf8',timeout:90000});assert.equal(created.status,0,created.stderr);
  const script=String.raw`import zipfile,sys
p=sys.argv[1]
with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('wb_relay_test/__init__.py','VERSION="1.0.7"\n')
 z.writestr('wb_relay_test-1.0.7.dist-info/METADATA','Metadata-Version: 2.1\nName: wb-relay-test\nVersion: 1.0.7\n')
 z.writestr('wb_relay_test-1.0.7.dist-info/WHEEL','Wheel-Version: 1.0\nGenerator: Whale Bone test\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
 z.writestr('wb_relay_test-1.0.7.dist-info/RECORD','')`;
  const wheel=path.join(dir,'wb_relay_test-1.0.7-py3-none-any.whl');
  const packaged=cp.spawnSync(PYTHON,['-c',script,wheel],{encoding:'utf8',timeout:30000});assert.equal(packaged.status,0,packaged.stderr);
  const sha=crypto.createHash('sha256').update(await fsp.readFile(wheel)).digest('hex');
  const fileUrl='https://files.pythonhosted.org/packages/demo/wb_relay_test-1.0.7-py3-none-any.whl';
  let indexHit=0,wheelHit=0;
  const fetchFile=async(url,dest)=>{
   if(url==='https://pypi.org/simple/wb-relay-test/'){indexHit++;await fsp.writeFile(dest,`<!doctype html><a href="${fileUrl}#sha256=${sha}">wb_relay_test-1.0.7-py3-none-any.whl</a>`);}
   else if(url===fileUrl){wheelHit++;await fsp.copyFile(wheel,dest);}else throw Error('Unexpected URL '+url);
  };
  await fsp.writeFile(path.join(dir,'req.txt'),'wb-relay-test==1.0.7 --hash=sha256:'+sha+'\n');
  const req=P.parseRequirementsFile(path.join(dir,'req.txt'),dir);
  const result=await P.runPip({interpreter:venv,root:dir,action:'install',packages:req.packages,requirementsText:req.text,fetchFile});
  assert.equal(result.code,0);assert.ok(indexHit);assert.ok(wheelHit);
  assert.match(cp.spawnSync(venv,['-c','import wb_relay_test; print(wb_relay_test.VERSION)'],{encoding:'utf8'}).stdout,/1\.0\.7/);
  // Unknown project should be identified as a 404 rather than a proxy/authentication failure.
  await assert.rejects(()=>P.runPip({interpreter:venv,root:dir,action:'install',packages:['nonexistent-wb-zzz-test'],fetchFile:async(url)=>{throw Error('Upstream HTTP 404 Not Found');}}),/Package not found on public PyPI/);
  // Real proxy error remains distinguishable.
  await assert.rejects(()=>P.runPip({interpreter:venv,root:dir,action:'install',packages:['nonexistent-wb-zzz-test'],fetchFile:async()=>{throw Error('Proxy authentication HTTP 407');}}),/PyPI relay failure:.*407/);
 }finally{await fsp.rm(dir,{recursive:true,force:true});}
});
