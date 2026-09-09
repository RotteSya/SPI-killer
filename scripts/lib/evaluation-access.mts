// Access protection is transport-only. Never include share tokens or cookies in run evidence.
export interface EvaluationAccess {
  headersFor(url:string):Record<string,string>;
}

export async function openEvaluationAccess(baseURL:string,shareToken?:string,timeoutMS=15_000):Promise<EvaluationAccess> {
  const failure=()=>new Error('Evaluation deployment access unavailable or expired');
  let base:URL;
  try {base=new URL(baseURL);}catch{throw failure();}
  const loopback=base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname);
  if(base.username||base.password||base.search||base.hash||(!loopback&&base.protocol!=='https:')||
    !Number.isSafeInteger(timeoutMS)||timeoutMS<1||timeoutMS>15_000)throw failure();
  let cookie:string|null=null,expires=Infinity;
  if(shareToken!==undefined) {
    if(!/^[A-Za-z0-9._~-]{1,4096}$/.test(shareToken)||(!loopback&&!base.hostname.endsWith('.vercel.app')))throw failure();
    const url=new URL('/',base);url.searchParams.set('_vercel_share',shareToken);
    let response:Response|undefined;
    try {
      response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(timeoutMS)});
      if(![200,301,302,303,307,308].includes(response.status))throw failure();
      const location=response.headers.get('location');
      if(location&&new URL(location,base).origin!==base.origin)throw failure();
      const cookies=response.headers.getSetCookie().filter(value=>value.startsWith('_vercel_jwt='));
      if(cookies.length!==1||cookies[0]!.length>16_384)throw failure();
      const parts=cookies[0]!.split(';').map(value=>value.trim());
      if(!/^_vercel_jwt=[A-Za-z0-9._~-]{1,8192}$/.test(parts[0]!))throw failure();
      const now=Date.now();expires=now+23*60*60*1000;
      for(const attribute of parts.slice(1)) {
        const match=/^(max-age|expires)=(.*)$/i.exec(attribute);
        if(!match)continue;
        const until=match[1]!.toLowerCase()==='max-age'
          ? (/^-?\d+$/.test(match[2]!)?now+Number(match[2])*1000:NaN):Date.parse(match[2]!);
        if(!Number.isFinite(until)||until<=now)throw failure();
        expires=Math.min(expires,until);
      }
      cookie=parts[0]!;
    } catch {throw failure();}
    finally {try{await response?.body?.cancel();}catch{/* Access failures never expose the token URL. */}}
  }
  return Object.freeze({headersFor(url:string):Record<string,string> {
    let target:URL;try{target=new URL(url);}catch{throw failure();}
    if(target.origin!==base.origin||target.username||target.password||Date.now()>=expires)throw failure();
    return cookie===null?{}:{cookie};
  }});
}
