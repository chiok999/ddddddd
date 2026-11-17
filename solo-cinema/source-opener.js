'use strict';
// `remote` is responsible for URL validation and DNS pinning on every request
// and redirect. Refresh is only supplied for provider-resolved sources.
function createSourceOpener({remote,safeUrl}) {
  async function request(entry,signal,offset,validator) {
    const headers={'accept-encoding':'identity'};
    if(offset){headers.range=`bytes=${offset}-`;headers['if-range']=validator;}
    if(entry.userAgent)headers['user-agent']=entry.userAgent;
    if(entry.referer)headers.referer=entry.referer;
    if(entry.origin)headers.origin=entry.origin;
    return remote(entry.url,headers,signal);
  }
  return async function open(entry,signal,offset=0,validator=null) {
    let response=await request(entry,signal,offset,validator);
    if(![401,403].includes(response.status) || !entry.refresh || signal.aborted)return response;
    await response.body?.cancel().catch(()=>{});
    const candidate=await entry.refresh();
    if(!candidate || signal.aborted)return response;
    const updated={...entry,url:safeUrl(candidate.url).href,referer:candidate.referer || null,origin:candidate.origin || null,userAgent:candidate.userAgent || null};
    response=await request(updated,signal,offset,validator);
    // An initial 200 is a new input; on a resume the range reader will verify
    // the original validator and length before admitting any of these bytes.
    return response;
  };
}
module.exports={createSourceOpener};
