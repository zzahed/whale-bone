'use strict';
/** Help text is deliberately diagnostic, not a request to evade enterprise network policy. */
function explainError(error){
 const text=String(error||'');
 if(/^(?:Invalid (?:timeout|output|model|User-Agent|authentication|settings)|Timeout must be |Output tokens must be |Model list too long|Invalid endpoint|Invalid proxy)/i.test(text))return '';
 if(/\b407\b|proxy authentication/i.test(text))return 'HTTP 407: proxy credentials were not accepted. Check Windows sign-in, approved proxy URL, and enterprise proxy policy with IT.';
 if(/\b401\b|unauthorized/i.test(text))return 'HTTP 401: check the API key, authentication mode, and account permissions.';
 if(/\b403\b|forbidden/i.test(text))return 'HTTP 403: access was denied. Ask IT to verify the approved endpoint and proxy policy.';
 if(/\b429\b|rate.?limit/i.test(text))return 'HTTP 429: rate limit exceeded. Reduce request frequency or ask your API provider or administrator about quotas.';
 if(/certificate|TLS|SSL|Schannel/i.test(text))return 'TLS/certificate error: verify Windows trusted corporate certificates and endpoint configuration with IT. Do not disable certificate checks.';
 if(/timed?\s*out|ETIMEDOUT|timeout/i.test(text))return 'Connection timeout: confirm proxy reachability, model latency, and enterprise network controls; adjust the timeout if authorized.';
 if(/ECONNRESET|connection reset/i.test(text))return 'Connection reset: inspect proxy logs and gateway health with IT.';
 return 'Check Output > Whale Bone for the reported error, and run the local self-check.';
}
module.exports={explainError};
