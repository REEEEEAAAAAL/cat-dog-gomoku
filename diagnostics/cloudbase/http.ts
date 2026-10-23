export async function fetchJsonWithTimeout(url:string,init:RequestInit,timeoutMs:number){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{...init,signal:controller.signal});
    const body:unknown=await response.json();
    return {response,body};
  }finally{clearTimeout(timer);}
}
