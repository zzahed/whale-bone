#!/usr/bin/env node
'use strict';
/** Windows-only, explicit CI command. No VS Code host, shell execution or extra npm packages. */
const path=require('node:path');
const pkg=require('../package.json');
const C=require('../src/ci-checks');
const {ApiTransport}=require('../src/transport');
// Proxy password for user proxy authentication comes only from the CI secret store.
function withProxyPassword(t,env){if(t&&!t.getProxyPassword)t.getProxyPassword=()=>env.WHALEBONE_PROXY_PASSWORD||'';return t;}
function argumentsFrom(args){const out={base:undefined,workspace:process.cwd()};for(let i=0;i<args.length;i++){
 if(args[i]==='--base'&&args[i+1])out.base=args[++i];
 else if(args[i]==='--workspace'&&args[i+1])out.workspace=path.resolve(args[++i]);
 else if(args[i]==='--help')out.help=true;
 else throw Error('Unknown argument. Expected --base <revision> [--workspace <path>]');
 }return out;
}
async function main(argv=process.argv.slice(2),env=process.env,transport=null){
 const args=argumentsFrom(argv);
 if(args.help){process.stdout.write('Whale Bone AI checks: node scripts/ci-check.js --base <trusted-full-base-commit-sha> [--workspace DIRECTORY]\n');return 0;}
 if(!args.base)throw Error('Pass an explicit trusted --base revision for your pull request');
 const baseCommit=C.resolveCommit(args.workspace,args.base);
 const checks=C.loadChecks(args.workspace,baseCommit);if(!checks.length)throw Error('No .whalebone/checks/*.md files. Copy the sample checks and commit them first.');
 const {paths,diff,skipped,reason,incomplete,deleted,excluded}=C.changedDiff(args.workspace,baseCommit);
 if(skipped){process.stdout.write('SKIPPED (not PASS): '+reason+'\n');return incomplete?2:0;}
 if(!paths.length){process.stdout.write('SKIPPED (not PASS): no eligible changed source files.\n');return 0;}
 if(process.platform!=='win32'&&!transport)throw Error('Run on an approved Windows self-hosted runner with Windows PowerShell 5.1');
 const key=env.WHALEBONE_API_KEY;if(!key)throw Error('Missing WHALEBONE_API_KEY from approved CI secret storage');
 const defaults=pkg.contributes.configuration.properties;
 const settings=key=>defaults['whaleBone.'+key].default;
 const proxyEnabled=env.WHALEBONE_PROXY_ENABLED?!/^(?:0|false|no|off)$/i.test(env.WHALEBONE_PROXY_ENABLED):settings('proxyEnabled');
 const config={baseUrl:env.WHALEBONE_BASE_URL||settings('baseUrl'),proxyEnabled,proxyUrl:env.WHALEBONE_PROXY_URL||settings('proxyUrl'),proxyAuth:env.WHALEBONE_PROXY_AUTH||settings('proxyAuth'),proxyUsername:env.WHALEBONE_PROXY_USERNAME||'',userAgent:settings('userAgent'),authMode:env.WHALEBONE_AUTH_MODE||settings('authMode'),model:env.WHALEBONE_MODEL||settings('model'),timeoutSeconds:settings('timeoutSeconds'),outputTokens:settings('outputTokens')};
 if(incomplete)process.stdout.write('PARTIAL REVIEW (not complete PASS): '+reason+'\n');
 const result=await C.evaluate({checks,files:paths,diff,transport:withProxyPassword(transport||new ApiTransport(path.resolve(__dirname,'..')),env),config,apiKey:key});
 for(const r of result.results){const verdict=r.pass?(incomplete?'PARTIAL PASS':'PASS'):'FAIL';process.stdout.write(`${verdict} ${r.name}: ${String(r.summary).replace(/[\r\n]/g,' ').slice(0,300)}\n`);for(const f of r.findings)process.stdout.write(`  - ${String(f).replace(/[\r\n]/g,' ').slice(0,300)}\n`);}
 return incomplete?2:(result.passed?0:1);
}
if(require.main===module)main().then(code=>{process.exitCode=code}).catch(e=>{console.error('Whale Bone CI check could not complete: '+String(e.message).replace(/sk-[A-Za-z0-9_-]{8,}/g,'[redacted]').slice(0,300));process.exitCode=2;});
module.exports={argumentsFrom,main};
