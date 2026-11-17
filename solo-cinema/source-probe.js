'use strict';
// Two tiny GETs check actual range responses, not merely Accept-Ranges or HEAD.
// The supplied opener must enforce public-address validation on every redirect.
async function probeRange(open, entry) {
  const signal=AbortSignal.timeout(10000);
  async function read(start,end) {
    const response=await open(entry,signal,start,end);
    try {
      const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      const total=match && Number(match[3]), length=response.headers.get('content-length');
      const type=response.headers.get('content-type') || '', encoding=response.headers.get('content-encoding') || 'identity';
      const ok=response.status===206 && match && Number(match[1])===start && Number(match[2])===end && Number.isSafeInteger(total) && total>end && (!length || length===String(end-start+1)) && encoding==='identity' && !/mpegurl|text\/html/i.test(type);
      return {ok:!!ok,total:ok?total:null,status:response.status,etag:response.headers.get('etag')};
    } finally { await response.body?.cancel().catch(()=>{}); }
  }
  const first=await read(0,1);
  if(!first.ok || first.total<4)return {addressable:false,size:null,status:first.status};
  const offset=Math.floor(first.total/2), second=await read(offset,offset+1);
  const ok=second.ok && first.total===second.total && (!first.etag || !second.etag || first.etag===second.etag);
  return {addressable:ok,size:ok?first.total:null,status:second.status};
}
module.exports={probeRange};
