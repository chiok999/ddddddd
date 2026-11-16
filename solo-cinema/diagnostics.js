'use strict';
// Never return raw upstream errors: they can contain signed URLs or credentials.
function describe(error) {
  const status=Number(error?.status);
  if(Number.isInteger(status) && status>=300 && status<=599) return `HTTP ${status}`;
  const codes=new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT']);
  const code=error?.code || error?.cause?.code;
  if(codes.has(code)) return String(code);
  if(error?.name==='TimeoutError' || error?.name==='AbortError') return 'request timed out';
  if(error?.code==='INVALID_PROVIDER_RESPONSE') return 'invalid provider response';
  return 'network or provider error';
}
module.exports={describe};
