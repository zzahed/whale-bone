'use strict';
const {validateEndpoint}=require('./transport');
const crypto=require('node:crypto');
// No vendor default: the user must configure an HTTPS, OpenAI-compatible endpoint ending /v1.
const DEFAULT='';
function approve(url){return validateEndpoint(url);}
function recipient(url){const u=new URL(validateEndpoint(url));return u.origin+u.pathname;}
// API keys are stored per destination so a key is never reused for a different endpoint.
function keyId(url){const target=validateEndpoint(url);return 'whalebone.modelKey.'+crypto.createHash('sha256').update(target).digest('hex').slice(0,32);}
module.exports={approve,recipient,keyId,DEFAULT};
