/** 超时覆盖响应头及 JSON 正文读取；网络、取消和解析失败原样抛给调用方。 */
export async function fetchJsonWithTimeout(url:string,init:RequestInit,timeoutMs:number){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{...init,signal:controller.signal});
    const body:unknown=await response.json();
    return {response,body};
  }finally{clearTimeout(timer);}
}
