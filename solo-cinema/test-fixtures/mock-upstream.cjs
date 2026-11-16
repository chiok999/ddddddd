'use strict';
// Test-process-only interception; never loaded by the application in production.
const Module=require('node:module');
const load=Module._load;
Module._load=function(name,parent,isMain){
  if(name!=='undici') return load.apply(this,arguments);
  return {Agent:class Agent {},fetch:async input=>{
    const url=String(input);
    const json=(data,extra={})=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json',...extra}});
    if(url.includes('aoneroom.com/wefeed-h5api-bff/home?')) return json({}, {'x-user':JSON.stringify({token:'fixture'})});
    if(url.includes('aoneroom.com/wefeed-h5api-bff/subject/search')) return json({data:{items:[{subject:{subjectId:'42',detailPath:'fixture',title:'Fixture Movie',subjectType:1}}]}});
    if(url.includes('aoneroom.com/wefeed-h5api-bff/media-player/get-domain')) return json({data:'https://player.example'});
    if(url.includes('player.example/wefeed-h5api-bff/subject/play')) return json({data:{hls:[{url:'https://cdn.example/master.m3u8'}]}});
    if(url.includes('kisskh.is/api/DramaList/Search')) return json([]);
    if(url.includes('v3-cinemeta.strem.io')) return json({metas:[]});
    if(url==='https://cdn.example/master.m3u8') return new Response('#EXTM3U\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}});
    if(url==='https://cdn.example/segment.ts') return new Response(Buffer.from('segment'),{headers:{'content-type':'video/mp2t'}});
    if(url==='https://cdn.example/redirect.m3u8') return new Response('',{status:302,headers:{location:'https://127.0.0.1/private'}});
    throw Error('Unexpected fixture request: '+url);
  }};
};
