'use strict';
/** Bounded diagnostics for the *selected workspace file only*. */
function summarizeDiagnostics(diagnostics,limit=6){const arr=(Array.isArray(diagnostics)?diagnostics:[]).slice(0,limit);
 return arr.map(d=>{const loc=Number.isInteger(d?.range?.start?.line)?d.range.start.line+1:1;const severity=typeof d?.severity==='number'?['Error','Warning','Info','Hint'][d.severity]||'Diagnostic':'Diagnostic';
 return `${severity} line ${loc}${d.code?` (${String(typeof d.code==='object'?d.code.value:d.code).slice(0,35)})`:''}: ${String(d.message||'').replace(/[\r\n\0]/g,' ').slice(0,220)}`;}).join('\n').slice(0,1900);
}
function contextNote({active,diagnostics}){if(!active)return '';const d=summarizeDiagnostics(diagnostics);
 return `Active editor (approved workspace only): ${String(active.path).slice(0,230)}${active.selection?`, selection lines ${active.selection.start}-${active.selection.end}`:''}.${d?'\nVS Code Problems for this same file:\n'+d:''}`.slice(0,2300);
}
module.exports={summarizeDiagnostics,contextNote};
