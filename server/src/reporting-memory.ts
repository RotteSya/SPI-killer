import type { ReportExpense, ReportExpenseInput, ReportQuery, ReportingFacts, ReportingStore, ReportSource } from './reporting.ts';
import { MemoryReportArchiveStore } from './report-archive.ts';
import { MemoryQualityStore } from './quality-memory.ts';
export class MemoryReportingStore implements ReportingStore {
  readonly quality=new MemoryQualityStore();
  readonly archives=new MemoryReportArchiveStore();
  private load:(q:ReportQuery)=>ReportingFacts;
  private device:(id:number)=>boolean;
  private lookup:(token:string)=>number|null;
  private sources=new Map<number,ReportSource>();
  private internal=new Map<number,boolean>();
  private references=new Map<string,{deviceId:number;internal:boolean}>();
  private expenses=new Map<string,ReportExpense>();
  private revision=0n;
  constructor(load:(q:ReportQuery)=>ReportingFacts,device:(id:number)=>boolean,lookup:(token:string)=>number|null){this.load=load;this.device=device;this.lookup=lookup;}
  async snapshot(q:ReportQuery):Promise<ReportingFacts>{
    const facts=this.load(q);
    facts.devices=facts.devices.map(d=>({...d,isInternal:this.internal.get(d.id)??false}));
    facts.receipts=facts.receipts?.map(r=>({...r,isInternal:r.deviceId!==null&&(this.internal.get(r.deviceId)??false)}));
    facts.sources=[...this.sources.values()].filter(s=>s.recordedAt<=q.asOf&&facts.devices.some(d=>d.id===s.deviceId)).map(s=>({...s}));
    facts.expenses=[...this.expenses.values()].filter(e=>e.recordedAt<=q.asOf&&e.cohortFrom===q.cohortFrom&&e.cohortTo===q.cohortTo).map(e=>({...e}));
    return structuredClone(facts);
  }
  async setInternal(deviceId:number,internal:boolean,reference:string):Promise<boolean>{
    if(!this.device(deviceId))return false;
    const previous=this.references.get(reference);if(previous)return previous.deviceId===deviceId&&previous.internal===internal;
    this.references.set(reference,{deviceId,internal});this.internal.set(deviceId,internal);return true;
  }
  async source(token:string,group:string,method:'self_reported'):Promise<boolean>{
    const id=this.lookup(token);if(id===null)return false;
    const previous=this.sources.get(id);if(previous)return previous.group===group&&previous.method===method;
    this.sources.set(id,{deviceId:id,group,method,recordedAt:new Date().toISOString()});return true;
  }
  async expense(input:ReportExpenseInput):Promise<boolean>{
    const previous=this.expenses.get(input.reference);
    if(previous){const {recordedAt:_at,revision:_revision,...value}=previous;return Object.keys(value).length===Object.keys(input).length&&Object.entries(value).every(([key,v])=>input[key as keyof ReportExpenseInput]===v);}
    this.revision++;this.expenses.set(input.reference,{...input,recordedAt:new Date().toISOString(),revision:String(this.revision)});return true;
  }
}
