import {sameCheckoutDecision,type CheckoutQueue,type CheckoutSnapshot,type CheckoutCatalog,type CheckoutDecision} from './checkout-reconciliation.ts';
export async function reconcileCheckout(queue:CheckoutQueue,reference:string,catalog:CheckoutCatalog,read:(id:string)=>Promise<CheckoutSnapshot>,decision?:CheckoutDecision,interactive=false) {
  const claim=await queue.claim(reference,interactive||!!decision);
  if(!claim){const existing=await queue.get(reference);
    if(existing?.state==='credited'&&decision&&existing.decision&&sameCheckoutDecision(existing.decision,decision))return 'credited' as const;
    return decision?'conflict' as const:'stale' as const;
  }
  try{return await queue.finish(claim,await read(reference),'stripe_api',catalog,decision);}
  catch{await queue.defer(claim);throw new Error('Checkout reconciliation unavailable');}
}
