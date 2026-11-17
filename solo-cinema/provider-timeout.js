'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const scope=new AsyncLocalStorage();
// Return promptly even if an injected adapter ignores cancellation. Production
// providerRequest also consumes this signal, aborting its in-flight fetch.
async function withDeadline(task,ms){
 const controller=new AbortController();let timer;
 try{return await scope.run(controller.signal,()=>Promise.race([
  Promise.resolve().then(()=>task(controller.signal)),
  new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Provider lookup timed out'));},ms);})
 ]));}finally{clearTimeout(timer);}
}
module.exports={scope,withDeadline};
