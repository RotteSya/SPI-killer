import {aggregateQuality,parseQualitySubmission,qualityDigest} from '../../server/src/quality.ts';
export async function uploadQualityRecord(raw:unknown,baseURL:string,adminToken:string):Promise<{id:string;revision:string;origin:string}> {
  const input=parseQualitySubmission(raw),expected=qualityDigest(aggregateQuality(input)),url=new URL(baseURL);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    (url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new Error('An explicit HTTPS origin or loopback HTTP origin is required');
  if(!adminToken.trim()||/\[SENSITIVE\]|\[REDACTED\]|placeholder|changeme|[\r\n]/i.test(adminToken))throw new Error('A usable quality admin token is required');
  const body=JSON.stringify(input);if(Buffer.byteLength(body)>2*1024*1024)throw new Error('Quality input exceeds 2 MiB');
  let response:Response;
  try{response=await fetch(new URL('/admin/quality',url),{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15_000),
    headers:{'content-type':'application/json','x-admin-token':adminToken},body});}
  catch{throw new Error('Quality upload did not confirm delivery; retry the identical input to reconcile');}
  if(!response.ok){await response.body?.cancel();throw new Error('Quality upload returned HTTP '+response.status);}
  if(!response.body)throw new Error('Quality upload returned no receipt');
  const chunks:Uint8Array[]=[];let length=0;
  for await(const chunk of response.body){length+=chunk.byteLength;if(length>1024*1024)throw new Error('Quality receipt exceeds limit');chunks.push(chunk);}
  let receipt:Record<string,unknown>;try{receipt=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Invalid quality upload receipt');}
  if(receipt.id!==expected||qualityDigest(receipt.report)!==expected||typeof receipt.revision!=='string'||! /^[1-9][0-9]*$/.test(receipt.revision))throw new Error('Quality upload receipt does not match the submitted evidence');
  return {id:expected,revision:receipt.revision,origin:url.origin};
}
