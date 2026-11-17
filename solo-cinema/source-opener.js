'use strict';
// `remote` is responsible for URL validation and DNS pinning on every request
// and redirect. Refresh is only supplied for provider-resolved sources.
function createSourceOpener({remote,safeUrl,now=Date.now}) {
  async function request(entry,signal,offset,validator) {
    const headers={'accept-encoding':'identity'};
    if(offset){headers.range=`bytes=${offset}-`;headers['if-range']=validator;}
    if(entry.userAgent)headers['user-agent']=entry.userAgent;
    if(entry.referer)headers.referer=entry.referer;
    if(entry.origin)headers.origin=entry.origin;
    return remote(entry.url,headers,signal);
  }
  return async function open(entry,signal,offset=0,validator=null) {
    let refreshed=null;
    async function refresh(){
      if(!entry.refresh || signal.aborted)return null;
      const candidate=await entry.refresh();
      return candidate && !signal.aborted ? {...entry,url:safeUrl(candidate.url).href,referer:candidate.referer || null,origin:candidate.origin || null,userAgent:candidate.userAgent || null} : null;
    }
    if(entry.refreshAt && now()>=entry.refreshAt){try{refreshed=await refresh();}catch{/* use the original link if refresh is unavailable */}}
    let response=await request(refreshed || entry,signal,offset,validator);
    if(![401,403].includes(response.status) || !entry.refresh || signal.aborted || refreshed)return response;
    await response.body?.cancel().catch(()=>{});
    refreshed=await refresh();
    if(!refreshed)return response;
    // Resumed responses still require a matching validator and exact range.
    return request(refreshed,signal,offset,validator);
  };
}
module.exports={createSourceOpener};
