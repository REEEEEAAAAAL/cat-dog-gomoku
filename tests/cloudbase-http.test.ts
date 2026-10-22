import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJsonWithTimeout } from '../diagnostics/cloudbase/http';

afterEach(()=>{
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CloudBase HTTP timeout compatibility',()=>{
  it('uses AbortController when AbortSignal.timeout is unavailable and clears the timer',async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
    Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
    const clearTimeoutSpy=vi.spyOn(globalThis,'clearTimeout');
    const fetchMock=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}});
    });
    vi.stubGlobal('fetch',fetchMock);
    try{
      const result=await fetchJsonWithTimeout('/probe',{method:'POST'},10_000);
      expect(result.response.ok).toBe(true);
      expect(result.body).toEqual({ok:true});
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    }finally{
      if(descriptor)Object.defineProperty(AbortSignal,'timeout',descriptor);
      else Reflect.deleteProperty(AbortSignal,'timeout');
    }
  });

  it('aborts a stalled request and clears the timer after failure',async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
    Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
    const clearTimeoutSpy=vi.spyOn(globalThis,'clearTimeout');
    const fetchMock=vi.fn((_url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    }));
    vi.stubGlobal('fetch',fetchMock);
    try{
      await expect(fetchJsonWithTimeout('/probe',{},5)).rejects.toThrow('Aborted');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    }finally{
      if(descriptor)Object.defineProperty(AbortSignal,'timeout',descriptor);
      else Reflect.deleteProperty(AbortSignal,'timeout');
    }
  });
});
