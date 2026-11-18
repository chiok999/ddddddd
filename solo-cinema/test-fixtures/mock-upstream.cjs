'use strict';
// Test-process-only interception; never loaded by the application in production.
const Module=require('node:module');
const load=Module._load;
Module._load=function(name,parent,isMain){
  if(name!=='undici') return load.apply(this,arguments);
  return {Agent:class Agent {},fetch:async (input,options={})=>{
    const url=String(input);
    const json=(data,extra={})=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json',...extra}});
    if(url.includes('aoneroom.com/wefeed-h5api-bff/home?')) return json({}, {'x-user':JSON.stringify({token:'fixture'})});
    if(url.includes('aoneroom.com/wefeed-h5api-bff/subject/search')) return json({data:{items:[{subject:{subjectId:'42',detailPath:'fixture',title:'Fixture Movie',subjectType:1}}]}});
    // A paged category: page 1 has more, page 2 ends. The subject shape is
    // nested exactly as the provider returns it, so the normalizer is exercised.
    if(url.includes('aoneroom.com/wefeed-h5api-bff/ranking-list/content')){
      const query=new URL(url).searchParams, page=Number(query.get('page')||1), id=query.get('id');
      if(id==='9999') return json({data:{items:[],pager:{hasMore:false,page:'1',perPage:20}}});
      const items=(page===1?[1,2,3]:[4,5]).map(n=>({subject:{subjectId:`c${n}`,detailPath:`cat-${n}`,title:`Cat ${n}`,subjectType:n%2?1:2,releaseDate:'2024-01-01',cover:{url:`https://pbcdn.aoneroom.com/${n}.jpg`}}}));
      return json({data:{items,pager:{hasMore:page===1,page:String(page),perPage:20,totalCount:5}}});
    }
    if(url.includes('aoneroom.com/wefeed-h5api-bff/media-player/get-domain')) return json({data:'https://player.example'});
    if(url.includes('player.example/wefeed-h5api-bff/subject/play')) return json({data:{hls:[{url:'https://cdn.example/master.m3u8'}]}});
    if(url.includes('kisskh.is/api/DramaList/Search')) return json([]);
    if(url.includes('v3-cinemeta.strem.io')) return json({metas:[]});
    if(url==='https://cdn.example/master.m3u8') return new Response('#EXTM3U\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}});
    if(url==='https://cdn.example/range.mp4'){const match=/^bytes=(\d+)-(\d+)$/.exec(new Headers(options.headers).get('range') || '');if(!match)return new Response('unexpected range',{status:400});return new Response('ab',{status:206,headers:{'content-range':`bytes ${match[1]}-${match[2]}/100`,'content-length':'2','content-type':'video/mp4'}});}
    if(url==='https://cdn.example/segment.ts') return new Response(Buffer.from('segment'),{headers:{'content-type':'video/mp2t'}});
    if(url==='https://cdn.example/redirect.m3u8') return new Response('',{status:302,headers:{location:'https://127.0.0.1/private'}});
    throw Error('Unexpected fixture request: '+url);
  }};
};
