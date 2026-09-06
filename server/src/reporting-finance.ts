import {financeTotals,type FinanceRevision} from './payment-finance.ts';
import {sameRefundIdentity} from './payment-ledger.ts';
import type {ReportOrder,ReportRefund} from './reporting.ts';

export function reportFinance(order:ReportOrder,revisions:FinanceRevision[],refunds:ReportRefund[],asOf:string){
  const revision=revisions.filter(r=>r.orderReference===order.reference&&r.recordedAt<=asOf).sort((a,b)=>BigInt(a.generation)>BigInt(b.generation)?-1:1)[0];
  if(!revision)return null;
  const latest=new Map<string,ReportRefund>();
  for(const r of refunds)if(r.recordedAt<=asOf&&((order.paymentIntentId&&r.snapshot.paymentIntentId===order.paymentIntentId)||(order.chargeId&&r.snapshot.chargeId===order.chargeId))&&
    (!latest.has(r.snapshot.id)||BigInt(latest.get(r.snapshot.id)!.generation)<BigInt(r.generation)))latest.set(r.snapshot.id,r);
  const actual=new Map(revision.snapshot.refunds.map(r=>[r.id,r]));
  const refundMismatch=actual.size!==latest.size||[...actual].some(([id,r])=>{const known=latest.get(id)?.snapshot;return !known||!sameRefundIdentity(known,r)||known.status!==r.status;});
  const totals=financeTotals(revision.snapshot,order.currency);
  return {revision,totals,refundMismatch,feesComplete:!revision.dirty&&!refundMismatch&&totals.feesComplete,
    cashUnknown:revision.dirty||refundMismatch||totals.disputesUnknown};
}
