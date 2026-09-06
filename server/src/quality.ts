import { createHash } from 'node:crypto';
import { proportion, reportTime } from './reporting.ts';

export const QUALITY_DEFINITION='independent-quality-v1';
export const QUALITY_PROFILES=['spi','reading_practice','general','legacy_objective'] as const;
export const QUALITY_KINDS=['single_choice','multiple_choice','ordering','short_fill','other'] as const;
export const QUALITY_LANGUAGES=['zh','ja','en'] as const;
type Profile=typeof QUALITY_PROFILES[number];
type Kind=typeof QUALITY_KINDS[number];
type Language=typeof QUALITY_LANGUAGES[number];
export interface QualityCombination {profile:Profile;kind:Exclude<Kind,'other'>;language:Language}
export interface QualityRun {
  id:string;dataset_id:string;dataset_role:'legacy_regression'|'holdout'|'diagnostic';
  dataset_sha256:string;results_sha256:string;family_split_sha256:string|null;
  contract:'objective_v1'|'screen_query_v1';scope_version:string;model:string;commit:string;app_version:string;
  started_at:string|null;finished_at:string;executor:string;
  expected_cases:number;
}
export interface QualityCase {
  case_sha256:string;family_sha256:string|null;profile:Profile;kind:Kind;language:Language;
  layout:'web'|'pdf'|'practice_ui'|'multi_page'|'single_image'|'unknown';
  expectation:'answerable'|'retake'|'out_of_scope'|'multiple_targets'|'unlabelled';
  risk:'none'|'missing_context'|'cropped'|'unreadable'|'ambiguous';
  state:'ready'|'review'|'retake'|'no_result'|'failed';
  parser_path:'v1'|'legacy_fallback'|'screen_no_result'|'none';protocol_valid:boolean;
  no_result_reason:'unsupported_scope'|'multiple_targets'|null;
  has_answer:boolean;answer_correct:boolean|null;
  request_ms:number|null;input_tokens:number|null;output_tokens:number|null;
}
export interface QualityReview {
  reviewer:string;reviewed_at:string;attestation_sha256:string;
  binding:'case_digest'|'legacy_summary_only';subject_sha256:string;
  labels_reviewed:boolean;results_reviewed:boolean;complete_run:boolean;no_selection_reruns:boolean;
  authorized_materials:boolean;family_split_verified:boolean;
}
export interface QualitySubmission {
  schema_version:1;run:QualityRun;declarations:QualityCombination[];cases:QualityCase[];review:QualityReview;
}
export class QualityValidationError extends Error {}
const invalid=():never=>{throw new QualityValidationError('Invalid independent evaluation evidence');};
function object(raw:unknown,keys:string[]):Record<string,unknown>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return invalid();
  if(Object.keys(raw).sort().join(',')!==keys.slice().sort().join(','))return invalid();return raw as Record<string,unknown>;
}
function choice<T extends string>(raw:unknown,values:readonly T[]):T {if(typeof raw!=='string'||!values.includes(raw as T))return invalid();return raw as T;}
function identifier(raw:unknown,max=100):string {if(typeof raw!=='string'||!new RegExp('^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,'+(max-1)+'}$').test(raw))return invalid();return raw;}
function sha(raw:unknown):string{if(typeof raw!=='string'||! /^[a-f0-9]{64}$/.test(raw))return invalid();return raw;}
function count(raw:unknown,max=1_000_000_000):number {if(typeof raw!=='number'||!Number.isSafeInteger(raw)||raw<0||raw>max)return invalid();return raw;}
function bool(raw:unknown):boolean {if(typeof raw!=='boolean')return invalid();return raw;}
function time(raw:unknown,now:number):string {try{const value=reportTime(raw);if(Date.parse(value)>now)return invalid();return value;}catch{return invalid();}}
// Code-unit key order, independent of machine locale. This binds the exact reviewed scored
// cases and version metadata, without retaining question text or normalized answers.
export function qualityCanonical(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(qualityCanonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>JSON.stringify(k)+':'+qualityCanonical(v)).join(',')+'}';
  return invalid();
}
export const qualityDigest=(value:unknown)=>createHash('sha256').update(qualityCanonical(value)).digest('hex');
export function qualityReviewSubject(input:Pick<QualitySubmission,'run'|'declarations'|'cases'>):string {
  return qualityDigest({run:input.run,declarations:input.declarations,cases:input.cases});
}
export function parseQualitySubmission(raw:unknown,now=Date.now()):QualitySubmission {
  const root=object(raw,['schema_version','run','declarations','cases','review']);if(root.schema_version!==1)return invalid();
  const r=object(root.run,['id','dataset_id','dataset_role','dataset_sha256','results_sha256','family_split_sha256','contract','scope_version','model','commit','app_version','started_at','finished_at','executor','expected_cases']);
  const run:QualityRun={id:identifier(r.id),dataset_id:identifier(r.dataset_id),dataset_role:choice(r.dataset_role,['legacy_regression','holdout','diagnostic']),
    dataset_sha256:sha(r.dataset_sha256),results_sha256:sha(r.results_sha256),family_split_sha256:r.family_split_sha256===null?null:sha(r.family_split_sha256),
    contract:choice(r.contract,['objective_v1','screen_query_v1']),scope_version:identifier(r.scope_version),model:identifier(r.model,150),
    commit:typeof r.commit==='string'&&/^[a-f0-9]{40}$/.test(r.commit)?r.commit:invalid(),app_version:identifier(r.app_version,64),
    started_at:r.started_at===null?null:time(r.started_at,now),finished_at:time(r.finished_at,now),executor:identifier(r.executor),expected_cases:count(r.expected_cases,5000)};
  if(run.expected_cases===0||(run.started_at&&run.started_at>run.finished_at))return invalid();
  if(!Array.isArray(root.declarations)||root.declarations.length>48||!Array.isArray(root.cases)||!root.cases.length||root.cases.length>run.expected_cases)return invalid();
  const declarations=root.declarations.map(raw=>{const d=object(raw,['profile','kind','language']);return {
    profile:choice(d.profile,QUALITY_PROFILES),kind:choice(d.kind,QUALITY_KINDS.slice(0,4) as QualityCombination['kind'][]),language:choice(d.language,QUALITY_LANGUAGES)};});
  const key=(d:{profile:string;kind:string;language:string})=>[d.profile,d.kind,d.language].join(':');
  if(new Set(declarations.map(key)).size!==declarations.length)return invalid();
  const cases:QualityCase[]=root.cases.map(raw=>{
    const c=object(raw,['case_sha256','family_sha256','profile','kind','language','layout','expectation','risk','state','parser_path','protocol_valid','no_result_reason','has_answer','answer_correct','request_ms','input_tokens','output_tokens']);
    const item:QualityCase={case_sha256:sha(c.case_sha256),family_sha256:c.family_sha256===null?null:sha(c.family_sha256),profile:choice(c.profile,QUALITY_PROFILES),kind:choice(c.kind,QUALITY_KINDS),language:choice(c.language,QUALITY_LANGUAGES),
      layout:choice(c.layout,['web','pdf','practice_ui','multi_page','single_image','unknown']),expectation:choice(c.expectation,['answerable','retake','out_of_scope','multiple_targets','unlabelled']),
      risk:choice(c.risk,['none','missing_context','cropped','unreadable','ambiguous']),state:choice(c.state,['ready','review','retake','no_result','failed']),
      parser_path:choice(c.parser_path,['v1','legacy_fallback','screen_no_result','none']),protocol_valid:bool(c.protocol_valid),
      no_result_reason:c.no_result_reason===null?null:choice(c.no_result_reason,['unsupported_scope','multiple_targets'] as const),
      has_answer:bool(c.has_answer),answer_correct:c.answer_correct===null?null:bool(c.answer_correct),
      request_ms:c.request_ms===null?null:count(c.request_ms),input_tokens:c.input_tokens===null?null:count(c.input_tokens),output_tokens:c.output_tokens===null?null:count(c.output_tokens)};
    const answerState=['ready','review'].includes(item.state);
    if(item.has_answer!==answerState||item.protocol_valid!==['v1','screen_no_result'].includes(item.parser_path))return invalid();
    if(item.parser_path==='none'&&item.state!=='failed')return invalid();
    if(item.parser_path==='legacy_fallback'&&item.state!=='review')return invalid();
    if(item.parser_path==='screen_no_result'&&(item.state!=='no_result'||item.no_result_reason===null||run.contract!=='screen_query_v1'))return invalid();
    if(item.state==='no_result'&&item.parser_path!=='screen_no_result')return invalid();
    if(item.state!=='no_result'&&item.no_result_reason!==null)return invalid();
    if(item.parser_path==='v1'&&item.state==='failed')return invalid();
    if((item.expectation==='unlabelled'||!item.has_answer)?item.answer_correct!==null:item.answer_correct===null)return invalid();
    if(item.answer_correct===true&&item.expectation!=='answerable')return invalid();
    return item;
  });
  if(new Set(cases.map(c=>c.case_sha256)).size!==cases.length)return invalid();
  if(run.dataset_role==='legacy_regression'&&(run.contract!=='objective_v1'||declarations.length||cases.some(c=>c.profile!=='legacy_objective')))return invalid();
  if(run.dataset_role!=='legacy_regression'&&[...cases,...declarations].some(c=>c.profile==='legacy_objective'))return invalid();
  const v=object(root.review,['reviewer','reviewed_at','attestation_sha256','binding','subject_sha256','labels_reviewed','results_reviewed','complete_run','no_selection_reruns','authorized_materials','family_split_verified']);
  const review:QualityReview={reviewer:identifier(v.reviewer),reviewed_at:time(v.reviewed_at,now),attestation_sha256:sha(v.attestation_sha256),
    binding:choice(v.binding,['case_digest','legacy_summary_only']),subject_sha256:sha(v.subject_sha256),labels_reviewed:bool(v.labels_reviewed),
    results_reviewed:bool(v.results_reviewed),complete_run:bool(v.complete_run),no_selection_reruns:bool(v.no_selection_reruns),authorized_materials:bool(v.authorized_materials),family_split_verified:bool(v.family_split_verified)};
  if(review.reviewer.toLowerCase()===run.executor.toLowerCase()||review.reviewed_at<run.finished_at)return invalid();
  if(review.complete_run&&cases.length!==run.expected_cases)return invalid();
  if(review.family_split_verified&&(!run.family_split_sha256||cases.some(c=>c.family_sha256===null)))return invalid();
  const input:QualitySubmission={schema_version:1,run,declarations,cases,review};
  if(review.binding==='case_digest'&&review.subject_sha256!==qualityReviewSubject(input))return invalid();
  if(review.binding==='legacy_summary_only'&&(run.dataset_role!=='legacy_regression'||run.contract!=='objective_v1'))return invalid();
  return input;
}
function measured(rows:QualityCase[],hit:(c:QualityCase)=>boolean,missing=(c:QualityCase)=>c.expectation==='unlabelled') {
  const unknown=rows.filter(missing).length,value=proportion(rows.filter(hit).length,rows.length);
  return {...value,rate:unknown?null:value.rate,confidence_interval_95:unknown?null:value.confidence_interval_95,unlabelled:unknown};
}
function metrics(rows:QualityCase[],declared:Set<string>) {
  const strict=rows.filter(c=>c.has_answer&&c.parser_path==='v1'),fallback=rows.filter(c=>c.has_answer&&c.parser_path==='legacy_fallback');
  const answerable=rows.filter(c=>c.expectation==='answerable'),scoped=answerable.filter(c=>declared.has([c.profile,c.kind,c.language].join(':')));
  const retake=rows.filter(c=>c.expectation==='retake');
  const latency=rows.flatMap(c=>c.request_ms===null?[]:[c.request_ms]).sort((a,b)=>a-b);
  const percent=(p:number)=>latency[Math.max(0,Math.ceil(latency.length*p)-1)]??null;
  const tokenRows=rows.filter(c=>c.input_tokens!==null&&c.output_tokens!==null);
  const unknownFamilies=rows.filter(c=>c.family_sha256===null).length;
  return {samples:rows.length,families:unknownFamilies?null:new Set(rows.map(c=>c.family_sha256)).size,unlabelled_families:unknownFamilies,unlabelled:rows.filter(c=>c.expectation==='unlabelled').length,
    protocol_valid:measured(rows,c=>c.protocol_valid,()=>false),answerable_accuracy:measured(answerable,c=>c.answer_correct===true),
    strict_usable_precision:measured(strict,c=>c.answer_correct===true),legacy_fallback_precision:measured(fallback,c=>c.answer_correct===true),
    declared_scope_coverage:measured(scoped,c=>c.has_answer),strict_scope_coverage:measured(scoped,c=>c.has_answer&&c.parser_path==='v1'),
    ready_precision:measured(strict.filter(c=>c.state==='ready'),c=>c.answer_correct===true),retake_recall:measured(retake,c=>c.state==='retake'&&c.protocol_valid),
    risk_blocking:Object.fromEntries(['missing_context','cropped','unreadable'].map(risk=>[risk,measured(retake.filter(c=>c.risk===risk),c=>c.state==='retake'&&c.protocol_valid)])),
    out_of_scope_recognition:measured(rows.filter(c=>c.expectation==='out_of_scope'),c=>c.state==='no_result'&&c.no_result_reason==='unsupported_scope'),
    multiple_target_recognition:measured(rows.filter(c=>c.expectation==='multiple_targets'),c=>c.state==='no_result'&&c.no_result_reason==='multiple_targets'),
    layouts:Object.fromEntries([...new Set(rows.map(c=>c.layout))].sort().map(layout=>[layout,rows.filter(c=>c.layout===layout).length])),
    request_latency_ms:{p50:percent(.5),p95:percent(.95),measured:latency.length,missing:rows.length-latency.length,definition:'evaluation_http_request_not_user_task_time'},
    tokens:{mean:tokenRows.length?tokenRows.reduce((sum,c)=>sum+c.input_tokens!+c.output_tokens!,0)/tokenRows.length:null,measured:tokenRows.length,missing:rows.length-tokenRows.length}};
}
export function aggregateQuality(input:QualitySubmission) {
  const declared=new Set(input.declarations.map(d=>[d.profile,d.kind,d.language].join(':')));
  const keys=new Set([...declared,...input.cases.map(c=>[c.profile,c.kind,c.language].join(':'))]);
  const cells=[...keys].sort().map(key=>{const [profile,kind,language]=key.split(':');return {profile,kind,language,declared:declared.has(key),
    ...metrics(input.cases.filter(c=>[c.profile,c.kind,c.language].join(':')===key),declared)};});
  const overall=metrics(input.cases,declared);
  // The new non-SPI sample budget cannot be filled by SPI cases, unlabelled
  // diagnostics, or undeclared combinations. Scope challenges remain separate.
  const newScopeCases=input.cases.filter(c=>['reading_practice','general'].includes(c.profile)&&c.kind!=='other'
    &&c.expectation!=='unlabelled'&&declared.has([c.profile,c.kind,c.language].join(':')));
  const newScopeSamples={definition:'labelled_non_spi_objective_cases_in_declared_combinations',samples:newScopeCases.length,
    by_kind:Object.fromEntries(QUALITY_KINDS.slice(0,4).map(kind=>[kind,newScopeCases.filter(c=>c.kind===kind).length]))};
  const byKind=QUALITY_KINDS.filter(kind=>input.cases.some(c=>c.kind===kind)).map(kind=>({kind,...metrics(input.cases.filter(c=>c.kind===kind),declared)}));
  const byLanguage=QUALITY_LANGUAGES.filter(language=>input.cases.some(c=>c.language===language)).map(language=>({language,...metrics(input.cases.filter(c=>c.language===language),declared)}));
  const thresholds:Array<{name:string;minimum:number;rate:ReturnType<typeof measured>;status:'met'|'failed'|'missing'}>=[];
  const check=(name:string,minimum:number,rate:ReturnType<typeof measured>)=>thresholds.push({name,minimum,rate,status:rate.rate===null?'missing':rate.rate>=minimum?'met':'failed'});
  check('protocol_valid',.98,overall.protocol_valid);check('answerable_accuracy',.92,overall.answerable_accuracy);
  check('ready_precision',.97,overall.ready_precision);check('retake_recall',.90,overall.retake_recall);
  byKind.filter(k=>k.kind!=='other').forEach(k=>check('kind_accuracy:'+k.kind,.85,k.answerable_accuracy));
  byLanguage.forEach(l=>check('language_accuracy:'+l.language,.85,l.answerable_accuracy));
  if(input.run.contract==='screen_query_v1'){
    check('declared_scope_coverage',.90,overall.declared_scope_coverage);
    check('out_of_scope_recognition',.95,overall.out_of_scope_recognition);check('multiple_target_recognition',.95,overall.multiple_target_recognition);
    cells.filter(c=>c.declared).forEach(c=>{check('scope_coverage:'+c.profile+':'+c.kind+':'+c.language,.90,c.declared_scope_coverage);
      check('ready_precision:'+c.profile+':'+c.kind+':'+c.language,.97,c.ready_precision);});
  }
  const evidenceGaps:string[]=[];
  for(const assertion of ['labels_reviewed','results_reviewed','complete_run','no_selection_reruns','authorized_materials'] as const)if(!input.review[assertion])evidenceGaps.push(assertion);
  if(input.review.binding!=='case_digest')evidenceGaps.push('review_does_not_bind_scored_case_bytes');
  if(input.run.dataset_role!=='holdout')evidenceGaps.push('not_new_scope_holdout');
  if(input.run.contract!=='screen_query_v1')evidenceGaps.push('not_screen_query_contract');
  if(!input.review.family_split_verified||!input.run.family_split_sha256)evidenceGaps.push('family_split_evidence_missing');
  if(newScopeSamples.samples<400)evidenceGaps.push('holdout_below_400');
  if(!declared.size)evidenceGaps.push('no_declared_combinations');
  for(const kind of QUALITY_KINDS.slice(0,4))if(newScopeSamples.by_kind[kind]!<100)evidenceGaps.push('kind_below_100:'+kind);
  for(const cell of cells.filter(c=>c.declared))if(cell.samples-cell.unlabelled<50)evidenceGaps.push('combination_below_50:'+cell.profile+':'+cell.kind+':'+cell.language);
  if(overall.unlabelled)evidenceGaps.push('unlabelled_cases');
  return {definition_version:QUALITY_DEFINITION,run:input.run,review:input.review,review_subject_sha256:qualityReviewSubject(input),
    execution:{expected_cases:input.run.expected_cases,recorded_cases:input.cases.length,missing_cases:input.run.expected_cases-input.cases.length},new_scope_sample_counts:newScopeSamples,
    submission_sha256:qualityDigest(input),declarations:input.declarations,overall,cells,by_kind:byKind,by_language:byLanguage,thresholds,evidence_gaps:evidenceGaps,
    assessment:thresholds.some(t=>t.status==='failed')?'thresholds_failed':evidenceGaps.length||thresholds.some(t=>t.status==='missing')?'insufficient_evidence':'thresholds_met',
    release_interpretation:'quality_readout_only; requires_exact_candidate_binding_baseline_comparison_explanation_review_software_and_rollout_gates',
    review_interpretation:'administrator_recorded_review_claim; digest_checks_integrity_not_reviewer_identity'};
}
export type QualityReport=ReturnType<typeof aggregateQuality>;
export interface QualityRecord {id:string;revision:string;created_at:string;report:QualityReport;withdrawal:QualityWithdrawal|null}
export const QUALITY_WITHDRAWAL_REASONS=['scoring_error','dataset_authorization_withdrawn','incomplete_run','incorrect_version_binding','review_withdrawn'] as const;
export interface QualityWithdrawal {reference:string;reason:typeof QUALITY_WITHDRAWAL_REASONS[number];recorded_at:string}
export interface QualityListQuery {
  limit:number;beforeRevision?:string;profile?:Profile;kind?:Kind;language?:Language;
  contract?:QualityRun['contract'];scopeVersion?:string;includeHistory?:boolean;
}
export interface QualityPage {items:QualityRecord[];next_revision:string|null}
export interface QualityStore {
  record(input:QualitySubmission):Promise<QualityRecord>;
  get(id:string):Promise<QualityRecord|null>;
  list(query:QualityListQuery):Promise<QualityPage>;
  withdraw(id:string,reference:string,reason:QualityWithdrawal['reason']):Promise<boolean>;
}
export class QualityConflictError extends Error {}
export function parseQualityList(raw:Record<string,unknown>):QualityListQuery {
  if(Object.keys(raw).some(k=>!['limit','before_revision','profile','kind','language','contract','scope_version','include_history'].includes(k)))return invalid();
  const q:QualityListQuery={limit:20};
  if(raw.limit!==undefined){if(typeof raw.limit!=='string'||! /^(?:[1-9]|1[0-9]|20)$/.test(raw.limit))return invalid();q.limit=Number(raw.limit);}
  if(raw.before_revision!==undefined){const v=raw.before_revision;if(typeof v!=='string'||! /^[1-9][0-9]{0,18}$/.test(v)||BigInt(v)>9223372036854775807n)return invalid();q.beforeRevision=v;}
  if(raw.profile!==undefined)q.profile=choice(raw.profile,QUALITY_PROFILES);
  if(raw.kind!==undefined)q.kind=choice(raw.kind,QUALITY_KINDS);
  if(raw.language!==undefined)q.language=choice(raw.language,QUALITY_LANGUAGES);
  if(raw.contract!==undefined)q.contract=choice(raw.contract,['objective_v1','screen_query_v1'] as const);
  if(raw.scope_version!==undefined)q.scopeVersion=identifier(raw.scope_version);
  if(raw.include_history!==undefined){q.includeHistory=choice(raw.include_history,['true','false'])==='true';}
  return q;
}
export function validateQualityList(q:QualityListQuery):void {
  parseQualityList({limit:String(q.limit),...(q.beforeRevision?{before_revision:q.beforeRevision}:{}),...(q.profile?{profile:q.profile}:{}),
    ...(q.kind?{kind:q.kind}:{}),...(q.language?{language:q.language}:{}),...(q.contract?{contract:q.contract}:{}),
    ...(q.scopeVersion?{scope_version:q.scopeVersion}:{}),...(q.includeHistory!==undefined?{include_history:String(q.includeHistory)}:{})});
}
export function qualityWithdrawal(reference:unknown,reason:unknown):Omit<QualityWithdrawal,'recorded_at'> {
  return {reference:identifier(reference),reason:choice(reason,QUALITY_WITHDRAWAL_REASONS)};
}
export function qualityRecord(id:string,revision:string,createdAt:string,payload:string,withdrawal:QualityWithdrawal|null):QualityRecord {
  let report:QualityReport;try{report=JSON.parse(payload) as QualityReport;}catch{throw new Error('Invalid quality archive');}
  if(qualityDigest(report)!==id)throw new Error('Quality archive checksum mismatch');
  return {id,revision,created_at:createdAt,report,withdrawal};
}
