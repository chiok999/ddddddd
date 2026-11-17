'use strict';
const {Readable}=require('node:stream');
const {setTimeout:delay}=require('node:timers/promises');

// Resume only a byte-identical representation: a length plus a strong HTTP
// validator and a strictly checked 206 response are required before splicing.
function resumableInput(first,open,signal,{retries=3,backoffMs=250}={}){
  const lengthHeader=first.headers.get('content-length');
  const total=lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  const length=Number.isSafeInteger(total) && total>=0 ? total : null;
  const etag=first.headers.get('etag');
  const validator=etag && !/^W\//i.test(etag) ? {name:'etag',value:etag} : first.headers.get('last-modified') ? {name:'last-modified',value:first.headers.get('last-modified')} : null;
  const encoding=(first.headers.get('content-encoding')||'identity').toLowerCase();
  async function* stream(){
    let response=first,offset=0,attempts=0;
    for(;;){
      try{
        for await(const chunk of Readable.fromWeb(response.body)){
          if(signal.aborted)throw Error('Transcode stopped');
          offset+=chunk.length;if(chunk.length)attempts=0;
          if(length!==null && offset>length)throw Error('Source exceeded declared length');
          yield chunk;
        }
        if(length===null || offset===length)return;
      }catch{/* retry only when the response can be safely resumed */}
      if(signal.aborted)throw Error('Transcode stopped');
      if(!validator || length===null || encoding!=='identity' || offset>=length)throw Error('Source stream failed; safe resume is unavailable');
      let accepted=false,validatorChanged=false;
      while(attempts<retries && !accepted){
        attempts++;
        await delay(backoffMs*2**(attempts-1),undefined,{signal});
        let next;
        try{
          next=await open(offset,validator.value);
          const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(next.headers.get('content-range')||'');
          const partLength=next.headers.get('content-length');
          const end=range && Number(range[2]);
          accepted=next.status===206 && !!next.body && !!range && Number(range[1])===offset && end===length-1 && Number(range[3])===length && (!partLength || Number(partLength)===length-offset) && (next.headers.get('content-encoding')||'identity').toLowerCase()==='identity' && next.headers.get(validator.name)===validator.value;
          if(next.status===206 && next.headers.get(validator.name)!==validator.value)validatorChanged=true;
          if(!accepted)await next.body?.cancel().catch(()=>{});
          else response=next;
        }catch{await next?.body?.cancel().catch(()=>{});}
      }
      if(!accepted)throw Error(validatorChanged?'Source changed; a fresh conversion is required':'Source stream failed; validated range retry exhausted');
    }
  }
  return Readable.from(stream());
}
module.exports={resumableInput};
