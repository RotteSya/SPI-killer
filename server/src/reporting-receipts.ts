import type {CheckoutSnapshot} from './checkout-reconciliation.ts';

export interface ReceiptOrder {
  reference:string;deviceId:number;paymentIntentId:string|null;amountMinor:string;currency:string;
}
/** Minimal signed cash evidence. No device tokens, hashes, customer data or provider payloads. */
export interface ReportReceipt {
  eventId:string;checkoutReference:string;paymentIntentId:string|null;mode:CheckoutSnapshot['mode'];
  amountMinor:string|null;currency:string|null;paidAt:string|null;recordedAt:string;recordedTimeKnown:boolean;
  deviceId:number|null;isInternal:boolean;identityConflict:boolean;matchedOrders:ReceiptOrder[];
}
export function receiptIdentity(snapshot:CheckoutSnapshot,receivedAt:string,device:{id:number;createdAt:string}|null,purchase:{deviceId:number;createdAt:string}|null) {
  const tokenID=device&&device.createdAt<=receivedAt?device.id:null,purchaseID=purchase&&purchase.createdAt<=receivedAt?purchase.deviceId:null;
  const missing=(snapshot.deviceTokenHash!==null&&tokenID===null)||(snapshot.purchaseSessionId!==null&&purchaseID===null);
  const conflict=snapshot.metadataInvalid||(tokenID!==null&&purchaseID!==null&&tokenID!==purchaseID);
  return {deviceId:conflict||missing?null:purchaseID??tokenID,identityConflict:conflict};
}

/** A checkout ID and a payment intent both identify a payment. Union both to catch rebinding. */
export function groupUnallocatedReceipts(receipts:ReportReceipt[],from:string,asOf:string) {
  const input=receipts.filter(r=>r.recordedAt>=from&&r.recordedAt<=asOf),parents=input.map((_,i)=>i),keys=new Map<string,number>();
  const find=(i:number):number=>{let root=i;while(parents[root]!==root)root=parents[root]!;while(parents[i]!==i){const next=parents[i]!;parents[i]=root;i=next;}return root;};
  for(const [i,row] of input.entries())for(const key of ['checkout:'+row.checkoutReference,...(row.paymentIntentId?['intent:'+row.paymentIntentId]:[])]) {
    const previous=keys.get(key);if(previous===undefined)keys.set(key,i);else parents[find(i)]=find(previous);
  }
  const groups=new Map<number,ReportReceipt[]>();for(const [i,row] of input.entries()){const key=find(i),list=groups.get(key)??[];list.push(row);groups.set(key,list);}
  return [...groups.values()].map(rows=>{
    const unique=(values:Array<string|number|null>)=>[...new Set(values.filter(v=>v!==null))];
    const intents=unique(rows.map(r=>r.paymentIntentId)),amounts=unique(rows.map(r=>r.amountMinor)),currencies=unique(rows.map(r=>r.currency));
    const devices=unique(rows.map(r=>r.deviceId)),orders=new Map<string,ReceiptOrder>();for(const row of rows)for(const order of row.matchedOrders)orders.set(order.reference,order);
    const identityConflict=devices.length>1||rows.some(r=>r.identityConflict);
    const financialConflict=intents.length>1||amounts.length>1||currencies.length>1||orders.size>1;
    const complete=rows.every(r=>r.recordedTimeKnown&&r.mode==='payment'&&r.amountMinor!==null&&BigInt(r.amountMinor)>0n&&r.currency!==null&&r.paymentIntentId!==null&&r.paidAt!==null&&r.paidAt<=asOf);
    const amount=amounts.length===1?String(amounts[0]):null,currency=currencies.length===1?String(currencies[0]):null;
    const order=[...orders.values()][0],creditConflict=!!order&&(amount!==null&&amount!==order.amountMinor||currency!==null&&currency!==order.currency||
      intents.length>0&&order.paymentIntentId!==null&&!intents.includes(order.paymentIntentId)||devices.some(id=>id!==order.deviceId));
    // A verified, immutable order resolves missing metadata; contradictory cash facts remain open.
    const classified=financialConflict||creditConflict?'conflict':order?'credited':identityConflict?'conflict':complete?'unallocated':'incomplete';
    const dates=rows.map(r=>r.paidAt).filter((v):v is string=>v!==null).sort();
    return {state:classified,receipt_count:rows.length,checkout_count:new Set(rows.map(r=>r.checkoutReference)).size,
      amount_minor:classified==='unallocated'?amount:null,currency,device_id:!identityConflict&&devices.length===1?Number(devices[0]):null,
      paid_at:dates[0]??null,first_recorded_at:rows.map(r=>r.recordedAt).sort()[0]!,credit_conflict:creditConflict,
      is_internal:!identityConflict&&rows.some(r=>r.isInternal),legacy_timing_unknown:rows.some(r=>!r.recordedTimeKnown),matched_order_references:[...orders.keys()].sort()};
  });
}
export type UnallocatedReceiptGroup=ReturnType<typeof groupUnallocatedReceipts>[number];
export function summarizeUnallocatedReceipts(groups:UnallocatedReceiptGroup[],cohortIDs:Set<number>,knownInternalIDs:Set<number>) {
  const pending=groups.filter(r=>r.state!=='credited'&&!r.is_internal&&!(r.device_id!==null&&knownInternalIDs.has(r.device_id)));
  const selected=pending.filter(r=>r.device_id!==null&&cohortIDs.has(r.device_id)),unassigned=pending.filter(r=>r.device_id===null);
  const summary=(rows:UnallocatedReceiptGroup[])=>({payment_groups:rows.length,receipt_deliveries:rows.reduce((s,r)=>s+r.receipt_count,0),
    conflicts:rows.filter(r=>r.state==='conflict').length,incomplete:rows.filter(r=>r.state==='incomplete').length,legacy_timing_unknown_groups:rows.filter(r=>r.legacy_timing_unknown).length,
    currencies:[...new Set(rows.map(r=>r.currency).filter((v):v is string=>v!==null))].sort().map(currency=>({currency,
      confirmed_gross_minor:rows.filter(r=>r.currency===currency&&r.state==='unallocated').reduce((s,r)=>s+BigInt(r.amount_minor!),0n).toString(),
      unresolved_groups:rows.filter(r=>r.currency===currency&&r.state!=='unallocated').length,net_minor:null})),
    unknown_currency_groups:rows.filter(r=>r.currency===null).length});
  return {cohort_uncredited:summary(selected),account_unassigned:summary(unassigned),
    other_registered_devices_pending:pending.filter(r=>r.device_id!==null&&!cohortIDs.has(r.device_id)).length,
    credited_groups_excluded:groups.filter(r=>r.state==='credited').length,
    interpretation:'signed_paid_receipts_received_in_report_window; gross_only_not_net; account_unassigned_not_attributed_to_registration_cohorts; never_add_to_order_cash_or_P28'};
}
