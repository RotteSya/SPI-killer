import type {FinanceSnapshot,FinanceTransaction} from '../../src/payment-finance.ts';
export const financeBase=Date.parse('2026-01-01T00:00:00.000Z');
export const financeAt=(day:number)=>new Date(financeBase+day*86_400_000).toISOString();
export const balanceTransaction=(overrides:Partial<FinanceTransaction>={}):FinanceTransaction=>({id:'txn_charge',sourceId:'ch_finance',currency:'USD',amountMinor:'1000',feeMinor:'30',netMinor:'970',createdAt:financeAt(0),category:'charge',...overrides});
export const financeSnapshot=():FinanceSnapshot=>({charges:[{id:'ch_finance',paymentIntentId:'pi_finance',currency:'USD',capturedMinor:'1000',paid:true,transactionId:'txn_charge'}],refunds:[],disputes:[],transactions:[balanceTransaction()]});
export function disputedSnapshot(status='lost'):FinanceSnapshot{
  const s=financeSnapshot();s.disputes=[{id:'du_finance',chargeId:'ch_finance',paymentIntentId:'pi_finance',currency:'USD',amountMinor:'1000',status,transactionIds:['txn_dispute']}];
  s.transactions.push(balanceTransaction({id:'txn_dispute',sourceId:'du_finance',category:'dispute',amountMinor:'-1000',feeMinor:'1500',netMinor:'-2500'}));
  if(status==='won'){s.disputes[0]!.transactionIds.push('txn_reversal');s.transactions.push(balanceTransaction({id:'txn_reversal',sourceId:'du_finance',category:'dispute_reversal',amountMinor:'1000',feeMinor:'-1500',netMinor:'2500'}));}
  return s;
}
