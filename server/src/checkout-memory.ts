import {validateEvent,type PaymentEvent,type PaidOrderInput} from './payment-ledger.ts';
import {checkoutSnapshotHash,validateCheckoutSnapshot,validateCheckoutDecision,validateCheckoutQuery,evaluateCheckout,checkoutDecisionCurrent,checkoutReview,
  type CheckoutCase,type CheckoutCatalog,type CheckoutClaim,type CheckoutContext,type CheckoutDecision,type CheckoutQuery,type CheckoutQueue,type CheckoutSnapshot} from './checkout-reconciliation.ts';

export interface MemoryCheckoutAccess {
  receipt(event:PaymentEvent):void;complete(reference:string):void;completeEvent(event:PaymentEvent):void;
  context(snapshot:CheckoutSnapshot,original:CheckoutSnapshot,decision?:CheckoutDecision):CheckoutContext;
  credit(event:PaymentEvent,order:PaidOrderInput):number|null;
  bind(purchaseId:string,reference:string):()=>void;
}
export class MemoryCheckoutQueue implements CheckoutQueue {
  private access:MemoryCheckoutAccess;
  private cases=new Map<string,CheckoutCase>();
  private deliveries=new Map<string,{hash:string;snapshot:CheckoutSnapshot;event:PaymentEvent;recordedAt:string}>();
  private decisions=new Map<string,{reference:string;decision:CheckoutDecision&{appliedAt:string}}>();
  private observations:Array<{reference:string;generation:string;source:string;snapshot:CheckoutSnapshot;reason:string|null}>=[];
  constructor(access:MemoryCheckoutAccess){this.access=access;}
  async receive(event:PaymentEvent,snapshot:CheckoutSnapshot):Promise<void>{
    validateEvent(event);validateCheckoutSnapshot(snapshot);
    if(event.resourceId!==snapshot.id||snapshot.paymentStatus!=='paid'||!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))throw new Error('Invalid paid Checkout receipt');
    this.access.receipt(event);const hash=checkoutSnapshotHash(snapshot),old=this.deliveries.get(event.id);
    if(old){if(old.hash!==hash)throw new Error('Checkout receipt conflict');return;}
    const now=new Date().toISOString(),existing=this.cases.get(snapshot.id);
    this.deliveries.set(event.id,{hash,snapshot:{...snapshot},event:{...event},recordedAt:now});
    if(!existing){this.cases.set(snapshot.id,{reference:snapshot.id,event:{...event},signed:{...snapshot},observed:null,observationSource:null,
      conflictingEvents:false,state:'queued',reason:null,generation:'0',attempts:0,retryAfter:null,createdAt:now,updatedAt:now,resolvedDeviceId:null,decision:null});return;}
    if(checkoutSnapshotHash(existing.signed)!==hash){existing.conflictingEvents=true;existing.state='review';existing.reason='conflicting_events';existing.retryAfter=null;existing.updatedAt=now;}
    else if(existing.state==='credited')this.access.completeEvent(event);
  }
  async claim(reference:string,interactive=false):Promise<CheckoutClaim|null>{
    const c=this.cases.get(reference);if(!c||c.state==='credited'||(c.state==='processing'&&c.retryAfter!>new Date().toISOString()))return null;
    if(!interactive&&(c.state==='review'||(c.state==='queued'&&c.retryAfter!==null&&c.retryAfter>new Date().toISOString())))return null;
    c.generation=String(BigInt(c.generation)+1n);c.attempts++;c.state='processing';c.retryAfter=new Date(Date.now()+60_000).toISOString();
    return structuredClone({reference,generation:c.generation,event:c.event,signed:c.signed});
  }
  async finish(claim:CheckoutClaim,snapshot:CheckoutSnapshot,source:'signed_event'|'stripe_api',catalog:CheckoutCatalog,decision?:CheckoutDecision):Promise<'credited'|'review'|'stale'|'conflict'>{
    validateCheckoutSnapshot(snapshot);if(decision)validateCheckoutDecision(decision);
    const stored=this.cases.get(claim.reference);if(!stored||stored.state!=='processing'||stored.generation!==claim.generation)return 'stale';
    if(snapshot.id!==claim.reference)throw new Error('Checkout observation mismatch');
    const c=structuredClone(stored),current=!decision||checkoutDecisionCurrent(c,snapshot,source,decision);
    c.observed={...snapshot};c.observationSource=source;c.updatedAt=new Date().toISOString();
    const prior=decision?this.decisions.get(decision.reference):undefined;
    if(!current||prior){checkoutReview(c,'review_changed');this.cases.set(c.reference,c);
      this.observations.push({reference:c.reference,generation:c.generation,source,snapshot:{...snapshot},reason:'review_changed'});return 'conflict';}
    const context=this.access.context(snapshot,c.signed,decision);c.resolvedDeviceId=context.purchase?.deviceId??context.originalDeviceId??context.deviceId;
    const outcome=evaluateCheckout(c,snapshot,catalog,context,decision);
    if('reason' in outcome){checkoutReview(c,outcome.reason);this.cases.set(c.reference,c);
      this.observations.push({reference:c.reference,generation:c.generation,source,snapshot:{...snapshot},reason:outcome.reason});return 'review';}
    const undo=outcome.linkPurchase?this.access.bind(outcome.order.purchaseSessionId!,c.reference):()=>{};
    try{if(this.access.credit(c.event,outcome.order)===null)throw new Error('Checkout account unavailable');}catch(error){undo();throw error;}
    c.state='credited';c.reason=null;c.retryAfter=null;if(decision){c.decision={...decision,appliedAt:c.updatedAt};this.decisions.set(decision.reference,{reference:c.reference,decision:{...c.decision}});}
    this.access.complete(c.reference);this.cases.set(c.reference,c);
    this.observations.push({reference:c.reference,generation:c.generation,source,snapshot:{...snapshot},reason:null});return 'credited';
  }
  async defer(claim:CheckoutClaim):Promise<void>{const c=this.cases.get(claim.reference);if(c?.state==='processing'&&c.generation===claim.generation)checkoutReview(c,'provider_unavailable');}
  async pending(now=new Date().toISOString(),limit=5):Promise<string[]>{return [...this.cases.values()].filter(c=>['queued','processing'].includes(c.state)&&(!c.retryAfter||c.retryAfter<=now))
    .sort((a,b)=>a.reference<b.reference?-1:1).slice(0,Math.max(1,Math.min(20,limit))).map(c=>c.reference);}
  async get(reference:string):Promise<CheckoutCase|null>{return structuredClone(this.cases.get(reference)??null);}
  reportReceipts(from:string,asOf:string) {return structuredClone([...this.deliveries.values()].filter(r=>r.recordedAt>=from&&r.recordedAt<=asOf));}
  async list(query:CheckoutQuery):Promise<{items:CheckoutCase[];next:string|null}>{
    validateCheckoutQuery(query);const rows=[...this.cases.values()].filter(c=>(!query.state||c.state===query.state)&&(!query.before||c.reference<query.before))
      .sort((a,b)=>a.reference>b.reference?-1:1),items=rows.slice(0,query.limit);return structuredClone({items,next:rows.length>query.limit?items.at(-1)!.reference:null});
  }
}
