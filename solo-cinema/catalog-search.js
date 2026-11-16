'use strict';
// Cinemeta is metadata, not an assurance of playable streams.
module.exports = function createCatalogSearch({request}) {
  return async query => {
    const results=await Promise.allSettled(['movie','series'].map(async type=>{
      const response=await request(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`,{timeoutMs:6000});
      if(!Array.isArray(response.json?.metas)) throw Error('Invalid Cinemeta search');
      return response.json.metas.slice(0,30).flatMap(meta=>{
        if(!/^tt\d{1,12}$/.test(meta.id||'') || typeof meta.name!=='string' || !meta.name.trim()) return [];
        const year=(String(meta.releaseInfo||meta.year||'').match(/\d{4}/)||[])[0]||'';
        return [{source:'cinemeta',title:meta.name.slice(0,150),type,year,overview:'',imdbId:meta.id,poster:`https://images.metahub.space/poster/small/${meta.id}/img`}];
      });
    }));
    if(results.every(r=>r.status==='rejected')) throw Error('Cinemeta search unavailable');
    return results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
  };
};
