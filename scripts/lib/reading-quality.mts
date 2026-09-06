import {readdir,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {aggregateQuality,parseQualitySubmission,qualityDigest,qualityReviewSubject,type QualityCase,type QualitySubmission} from '../../server/src/quality.ts';
import {proportion} from '../../server/src/reporting.ts';
import {bytesSHA,evidenceJSON,parseReadingManifest,parseReadingStream,readEvidenceFile,ReadingEvidenceError,scoreReadingCase,validateCorpusReview,
  type LoadedReadingCorpus,type ReadingDraft,type ReadingReceipt} from './reading-evaluation.mts';
import {draftReadingRun,validateReadingCandidate,type ReadingCompletion,type ReadingResponse,type ReadingResponseIndex,type ReadingRunPlan} from './reading-runner.mts';
import {callUpperCNY,validateEvaluationPolicy,type EvaluationCallBound,type EvaluationPolicy} from './evaluation-budget.mts';

function fail(message='Reading archive integrity check failed'):never {throw new ReadingEvidenceError(message);}
function keys(value:unknown,names:string[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==names.slice().sort().join(','))fail();
}
function number(value:unknown,max=Number.MAX_SAFE_INTEGER):asserts value is number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)fail();
}
function hash(value:unknown):asserts value is string {if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))fail();}
function uuid(value:unknown):asserts value is string {if(typeof value!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))fail();}
function identifier(value:unknown):asserts value is string {if(typeof value!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value))fail();}
function time(value:unknown,now:number):asserts value is string {
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value||Date.parse(value)>now)fail();
}
function equal(a:unknown,b:unknown):void {if(qualityDigest(a)!==qualityDigest(b))fail();}
function stream(row:ReadingResponse) {
  if(row.failure||row.http_status!==200||row.content_type?.split(';')[0]?.trim().toLowerCase()!=='text/event-stream')return null;
  try{return parseReadingStream(row.body,row.capture_id,row.purpose==='answer'?'solve':'explain');}catch{return null;}
}
export interface ExplanationEvidence {
  capture_id:string;parent_capture_id:string;case_sha256:string;kind:QualityCase['kind'];parent_state:QualityCase['state'];
  parent_parser_path:QualityCase['parser_path'];response_sha256:string;usable:boolean;input_tokens:number|null;output_tokens:number|null;
}
export interface ReadingArchive {
  draft:ReadingDraft;plan:ReadingRunPlan;completion:ReadingCompletion;
  explanations:ExplanationEvidence[];explanation_subject_sha256:string;
  rejection_checks:Array<{parent_state:string;response_sha256:string;rejected:boolean}>;
  cost_bounds:Array<{purpose:ReadingResponse['purpose'];calls:number;reserved_cny_micros:number;unreserved_calls:number;input_tokens:number|null;output_tokens:number|null}>;
}

/** Offline only: reconstruct scores from every indexed raw response, never trust edited scores. */
export async function loadReadingArchive(directory:string,now=Date.now()):Promise<ReadingArchive> {
  const root=await realpath(resolve(directory));
  const responseDirectory=await realpath(resolve(root,'responses'));
  if(responseDirectory!==resolve(root,'responses'))fail();
  const read=(name:string,limit=1024*1024)=>readEvidenceFile(resolve(root,name),limit);
  const planBytes=await read('run.json',8*1024*1024),rawPlan=evidenceJSON(planBytes);
  keys(rawPlan,['schema_version','run_id','started_at','executor','candidate','candidate_sha256','manifest_sha256','family_split_sha256','corpus_review_sha256','cost_bound_sha256','budget_policy_sha256','planned_cases','explanation_policy','budget','admission']);
  if(rawPlan.schema_version!==1)fail();identifier(rawPlan.run_id);identifier(rawPlan.executor);time(rawPlan.started_at,now);
  for(const field of ['candidate_sha256','manifest_sha256','family_split_sha256','corpus_review_sha256','cost_bound_sha256','budget_policy_sha256'])hash(rawPlan[field]);
  const manifestBytes=await read('manifest.json',8*1024*1024),manifest=parseReadingManifest(evidenceJSON(manifestBytes));
  if(bytesSHA(manifestBytes)!==rawPlan.manifest_sha256||manifest.family_split.sha256!==rawPlan.family_split_sha256||manifest.authorization_review.sha256!==rawPlan.corpus_review_sha256)fail();
  const review=validateCorpusReview(manifest,await read('family-split.json'),await read('corpus-review.json'),rawPlan.executor,Date.parse(rawPlan.started_at));
  const corpus:LoadedReadingCorpus={root,manifest,manifestBytes,manifestSHA:bytesSHA(manifestBytes),review};
  const candidateBytes=await read('candidate.json'),candidate=validateReadingCandidate(evidenceJSON(candidateBytes),manifest.scope_version,Date.parse(rawPlan.started_at));
  equal(candidate,rawPlan.candidate);
  if(bytesSHA(candidateBytes)!==rawPlan.candidate_sha256||bytesSHA(await read('candidate-evidence.bin'))!==candidate.verification_sha256)fail();
  if(!Array.isArray(rawPlan.planned_cases)||rawPlan.planned_cases.length!==manifest.cases.length)fail();
  const captureIDs=new Set<string>();
  for(const [i,item] of rawPlan.planned_cases.entries()) {
    keys(item,['case_id','capture_id']);uuid(item.capture_id);
    if(item.case_id!==manifest.cases[i]!.id||captureIDs.has(item.capture_id))fail();captureIDs.add(item.capture_id);
  }
  equal(rawPlan.explanation_policy,{per_kind:manifest.explanations_per_kind,selection:'first_usable_in_manifest_order',rejection_checks:2});
  keys(rawPlan.budget,['calls','upper_cny_micros','remaining_cny_micros']);
  for(const value of Object.values(rawPlan.budget))number(value);
  const callCount=manifest.cases.length+4*manifest.explanations_per_kind+2;
  if(rawPlan.budget.calls!==callCount||Number(rawPlan.budget.upper_cny_micros)<=0||Number(rawPlan.budget.upper_cny_micros)>Number(rawPlan.budget.remaining_cny_micros)||Number(rawPlan.budget.upper_cny_micros)%callCount!==0)fail();
  const boundBytes=await read('cost-bound.json'),policyBytes=await read('budget-policy.json');
  if(bytesSHA(boundBytes)!==rawPlan.cost_bound_sha256||bytesSHA(policyBytes)!==rawPlan.budget_policy_sha256)fail();
  const bound=evidenceJSON(boundBytes) as EvaluationCallBound,policy=evidenceJSON(policyBytes) as EvaluationPolicy;validateEvaluationPolicy(policy);
  const upper=callUpperCNY(bound,candidate.model,candidate.base_url,Date.parse(rawPlan.started_at));
  if(upper*callCount!==rawPlan.budget.upper_cny_micros||Number(rawPlan.budget.remaining_cny_micros)>policy.limit_micros)fail();
  keys(rawPlan.admission,['checked_at','account_balance','config_revision','provider']);time(rawPlan.admission.checked_at,now);number(rawPlan.admission.account_balance);
  if(rawPlan.admission.checked_at>rawPlan.started_at||rawPlan.admission.account_balance<manifest.cases.length||rawPlan.admission.config_revision!==candidate.config_revision||
    typeof rawPlan.admission.provider!=='string'||manifest.dataset_role==='holdout'&&!['anthropic','deepseek','openai'].includes(rawPlan.admission.provider))fail();
  const plan=rawPlan as unknown as ReadingRunPlan;
  const rawCompletion=evidenceJSON(await read('completion.json'));
  keys(rawCompletion,['schema_version','plan_sha256','finished_at','complete','halt_reason','results_sha256','draft_sha256','review_subject_sha256','answer_cases','explanation_calls','rejection_checks','unresolved_dispatches']);
  if(rawCompletion.schema_version!==1||typeof rawCompletion.complete!=='boolean')fail();time(rawCompletion.finished_at,now);
  for(const field of ['plan_sha256','results_sha256','draft_sha256','review_subject_sha256'])hash(rawCompletion[field]);
  for(const field of ['answer_cases','explanation_calls','rejection_checks','unresolved_dispatches'])number(rawCompletion[field],10_000);
  if(rawCompletion.halt_reason!==null)identifier(rawCompletion.halt_reason);
  if(rawCompletion.plan_sha256!==bytesSHA(planBytes)||rawCompletion.finished_at<plan.started_at||rawCompletion.unresolved_dispatches!==0)fail('Archive has unfinished or unaccounted dispatches');
  const completion=rawCompletion as unknown as ReadingCompletion;
  const indexBytes=await read('results.json',8*1024*1024),rawIndex=evidenceJSON(indexBytes);
  if(bytesSHA(indexBytes)!==completion.results_sha256||!Array.isArray(rawIndex)||rawIndex.length>callCount)fail();
  const rows:ReadingResponse[]=[],index:ReadingResponseIndex[]=[],files=new Set<string>(),allIDs=new Set<string>();let previous=plan.started_at;
  const receipts=new Map<string,ReadingReceipt|null>(),refusals=new Map<string,boolean>(),answerScores:QualityCase[]=[];
  for(const value of rawIndex) {
    keys(value,['file','sha256','case_id','capture_id','purpose']);hash(value.sha256);identifier(value.case_id);uuid(value.capture_id);
    if(typeof value.file!=='string'||! /^responses\/[a-f0-9-]{36}\.json$/.test(value.file)||files.has(value.file)||allIDs.has(value.capture_id))fail();
    files.add(value.file);allIDs.add(value.capture_id);
    const bytes=await read(value.file,13*1024*1024);if(bytesSHA(bytes)!==value.sha256)fail('Raw response digest mismatch');
    const raw=evidenceJSON(bytes);
    keys(raw,['schema_version','case_id','capture_id','parent_capture_id','purpose','dispatch_id','upper_cny_micros','started_at','finished_at','request_ms','http_status','content_type','failure','body']);
    uuid(raw.dispatch_id);uuid(raw.capture_id);identifier(raw.case_id);time(raw.started_at,now);time(raw.finished_at,now);number(raw.request_ms,1_000_000_000);
    if(raw.schema_version!==1||raw.case_id!==value.case_id||raw.capture_id!==value.capture_id||raw.purpose!==value.purpose||!['answer','explain','explain_rejection'].includes(String(raw.purpose))||
      value.file!==`responses/${raw.dispatch_id}.json`||raw.started_at<previous||raw.finished_at<raw.started_at||raw.finished_at>completion.finished_at||
      typeof raw.body!=='string'||Buffer.byteLength(raw.body)>2*1024*1024||raw.content_type!==null&&(typeof raw.content_type!=='string'||raw.content_type.length>4096))fail();
    if(raw.http_status!==null){number(raw.http_status,599);if(raw.http_status<100)fail();}
    if(raw.upper_cny_micros!==null){number(raw.upper_cny_micros);if(raw.upper_cny_micros!==plan.budget.upper_cny_micros/callCount)fail();}
    if(raw.failure!==null&&!['not_dispatched','transport_failed'].includes(String(raw.failure)))fail();
    if(raw.failure===null?(raw.http_status===null||raw.upper_cny_micros===null):raw.http_status!==null||raw.content_type!==null||raw.body!=='')fail();
    if((raw.failure==='not_dispatched')!==(raw.upper_cny_micros===null))fail();
    if(raw.upper_cny_micros!==null)callUpperCNY(bound,candidate.model,candidate.base_url,Date.parse(raw.started_at));
    if(raw.purpose==='answer'){if(raw.parent_capture_id!==null)fail();}else uuid(raw.parent_capture_id);
    const dispatchFile=`responses/${raw.dispatch_id}.dispatch.json`,dispatch=evidenceJSON(await read(dispatchFile));
    equal(dispatch,{schema_version:1,case_id:raw.case_id,capture_id:raw.capture_id,parent_capture_id:raw.parent_capture_id,dispatch_id:raw.dispatch_id,purpose:raw.purpose,started_at:raw.started_at});
    const row=raw as unknown as ReadingResponse,result=stream(row);receipts.set(row.capture_id,result?.receipt??null);
    if(row.purpose==='answer') {
      const item=manifest.cases.find(c=>c.id===row.case_id);if(!item)fail();answerScores.push(scoreReadingCase(corpus,item,result,row.request_ms));
    }else if(row.purpose==='explain_rejection') {
      let code:unknown;try{code=(evidenceJSON(Buffer.from(row.body)) as {error?:{code?:unknown}})?.error?.code;}catch{/* A malformed refusal fails its check. */}
      refusals.set(row.capture_id,row.http_status===409&&code==='binding_mismatch'&&!row.failure);
    }
    // At most one bounded response body is resident while rebuilding a large corpus.
    files.add(dispatchFile);previous=raw.finished_at;rows.push({...row,body:''});index.push(value as unknown as ReadingResponseIndex);
  }
  // An orphan file can represent a charged, lost response. It must never disappear from review.
  equal((await readdir(responseDirectory)).map(name=>'responses/'+name).sort(),[...files].sort());
  const draft={...draftReadingRun(corpus,plan,[],completion.results_sha256,completion.finished_at),cases:answerScores};
  const draftBytes=await read('quality-draft.json',8*1024*1024);
  if(bytesSHA(draftBytes)!==completion.draft_sha256||qualityReviewSubject(draft)!==completion.review_subject_sha256)fail();equal(evidenceJSON(draftBytes),draft);
  if(completion.answer_cases!==draft.cases.length||completion.explanation_calls!==rows.filter(r=>r.purpose==='explain').length||completion.rejection_checks!==rows.filter(r=>r.purpose==='explain_rejection').length||
    completion.complete!==(!completion.halt_reason&&draft.cases.length===manifest.cases.length))fail();
  if(completion.complete&&(Date.parse(completion.finished_at)>=Date.parse(review.expires_at)||Date.parse(completion.finished_at)>=Date.parse(candidate.expires_at)))fail();
  // Validate the frozen selection and execution order, including immediate auxiliary calls.
  let position=0;const selected=new Map<string,number>(),rejectedStates=new Set<string>(),explanations:ExplanationEvidence[]=[],rejections:ReadingArchive['rejection_checks']=[];
  for(let i=0;i<rows.length;i++) {
    const row=rows[i]!,item=manifest.cases[position],planned=plan.planned_cases[position],score=draft.cases[position];
    if(row.purpose!=='answer'||!item||!planned||row.case_id!==item.id||row.capture_id!==planned.capture_id||!score)fail('Answer run was reordered, selected or retried');
    position++;const result=receipts.get(row.capture_id);let expected:ReadingResponse['purpose']|null=null;
    if(score.has_answer&&item.expectation==='answerable'&&item.kind!=='other'&&(selected.get(item.kind)??0)<manifest.explanations_per_kind) {
      expected='explain';selected.set(item.kind,(selected.get(item.kind)??0)+1);
    }else if(result&&['retake','no_result'].includes(result.terminal_state)&&!rejectedStates.has(result.terminal_state)) {
      expected='explain_rejection';rejectedStates.add(result.terminal_state);
    }
    const next=rows[i+1];
    if(expected&&next&&next.purpose!=='answer') {
      if(next.purpose!==expected||next.parent_capture_id!==row.capture_id||next.case_id!==row.case_id||captureIDs.has(next.capture_id))fail();
      i++;const evidence=index[i]!;
      if(expected==='explain') {
        const auxiliary=receipts.get(next.capture_id);
        explanations.push({capture_id:next.capture_id,parent_capture_id:row.capture_id,case_sha256:score.case_sha256,kind:item.kind,parent_state:score.state,parent_parser_path:score.parser_path,
          response_sha256:evidence.sha256,usable:auxiliary?.usable_result===true,input_tokens:auxiliary&&auxiliary.input_tokens>0?auxiliary.input_tokens:null,
          output_tokens:auxiliary&&auxiliary.output_tokens>0?auxiliary.output_tokens:null});
      }else {
        rejections.push({parent_state:result!.terminal_state,response_sha256:evidence.sha256,rejected:refusals.get(next.capture_id)===true});
      }
    }else if(expected&&(completion.complete||i<rows.length-1))fail('Frozen explanation selection was skipped');
  }
  const costBounds=(['answer','explain','explain_rejection'] as const).map(purpose=>{
    const calls=rows.filter(r=>r.purpose===purpose),usage=calls.map(r=>receipts.get(r.capture_id));
    return {purpose,calls:calls.length,reserved_cny_micros:calls.reduce((s,r)=>s+(r.upper_cny_micros??0),0),unreserved_calls:calls.filter(r=>r.upper_cny_micros===null).length,
      input_tokens:calls.length&&usage.every(s=>s&&s.input_tokens>0)?usage.reduce((sum,s)=>sum+s!.input_tokens,0):null,
      output_tokens:calls.length&&usage.every(s=>s&&s.output_tokens>0)?usage.reduce((sum,s)=>sum+s!.output_tokens,0):null};
  });
  return {draft,plan,completion,explanations,explanation_subject_sha256:qualityDigest({run_id:plan.run_id,results_sha256:completion.results_sha256,explanations,rejection_checks:rejections}),rejection_checks:rejections,cost_bounds:costBounds};
}

export async function prepareReadingQuality(directory:string,reviewFile:string,explanationReviewFile?:string,now=Date.now()) {
  const archive=await loadReadingArchive(directory,now),reviewBytes=await readEvidenceFile(reviewFile,1024*1024),review=evidenceJSON(reviewBytes);
  keys(review,['schema_version','reviewer','reviewed_at','subject_sha256','labels_reviewed','results_reviewed','complete_run','no_selection_reruns','authorized_materials','family_split_verified']);
  const {schema_version,...claim}=review;if(schema_version!==1||claim.complete_run!==archive.completion.complete)fail('Review does not match the complete/partial run');
  const submission:QualitySubmission=parseQualitySubmission({...archive.draft,review:{...claim,binding:'case_digest',attestation_sha256:bytesSHA(reviewBytes)}},now);
  const auxiliary=await reviewExplanations(archive,explanationReviewFile,now);
  return {submission,report:aggregateQuality(submission),provenance:{schema_version:1,plan_sha256:archive.completion.plan_sha256,
    candidate_sha256:archive.plan.candidate_sha256,candidate_verification_sha256:archive.plan.candidate.verification_sha256,
    review_interpretation:'independent_review_claim; hashes_check_integrity_not_identity',explanations:auxiliary,cost_bounds:archive.cost_bounds,
    cost_interpretation:'reserved_conservative_CNY_bounds_not_actual_invoices; auxiliary_calls_separate_from_240_case_baseline',
    release_ready:false,pending_release_gates:['exact_candidate_240_case_same_model_baseline','native_machine_line_and_accessibility_checks','production_platform_verification','staged_rollout','economic_observation']}};
}

async function reviewExplanations(archive:ReadingArchive,path:string|undefined,now:number) {
  const evidence=archive.explanations;
  const coverage={samples:evidence.length,usable:evidence.filter(e=>e.usable).length,by_kind:Object.fromEntries(['single_choice','multiple_choice','ordering','short_fill'].map(k=>[k,evidence.filter(e=>e.kind===k).length])),
    ready:evidence.filter(e=>e.parent_state==='ready').length,review:evidence.filter(e=>e.parent_state==='review').length,fallback:evidence.filter(e=>e.parent_parser_path==='legacy_fallback').length};
  let correct:number|null=null,severe:number|null=null,leaks:number|null=null,rewrites:number|null=null,attestation:string|null=null;
  if(path) {
    const bytes=await readEvidenceFile(path,1024*1024),raw=evidenceJSON(bytes);
    keys(raw,['schema_version','reviewer','reviewed_at','subject_sha256','results_reviewed','cases']);identifier(raw.reviewer);time(raw.reviewed_at,now);
    if(raw.schema_version!==1||raw.reviewer.toLowerCase()===archive.plan.executor.toLowerCase()||raw.reviewed_at<archive.completion.finished_at||raw.subject_sha256!==archive.explanation_subject_sha256||raw.results_reviewed!==true||!Array.isArray(raw.cases)||raw.cases.length!==evidence.length)fail('Independent explanation review is incomplete or bound to different evidence');
    correct=0;severe=0;leaks=0;rewrites=0;attestation=bytesSHA(bytes);const seen=new Set<string>();
    for(const entry of raw.cases) {
      keys(entry,['capture_id','response_sha256','correct','consistent','no_unrelated_inference','material_leak','silent_answer_rewrite','severe_contradiction']);uuid(entry.capture_id);hash(entry.response_sha256);
      for(const key of ['correct','consistent','no_unrelated_inference','material_leak','silent_answer_rewrite','severe_contradiction'])if(typeof entry[key]!=='boolean')fail();
      const row=evidence.find(e=>e.capture_id===entry.capture_id);
      if(!row||row.response_sha256!==entry.response_sha256||seen.has(entry.capture_id)||entry.correct===true&&!row.usable)fail();seen.add(entry.capture_id);
      if(row.usable&&entry.correct&&entry.consistent&&entry.no_unrelated_inference)correct++;
      if(entry.severe_contradiction)severe++;if(entry.material_leak)leaks++;if(entry.silent_answer_rewrite)rewrites++;
    }
  }
  const enough=coverage.samples>=80&&Object.values(coverage.by_kind).every(n=>n>0)&&coverage.ready>0&&coverage.review>0&&coverage.fallback>0;
  const rejected=['retake','no_result'].every(state=>archive.rejection_checks.some(c=>c.parent_state===state&&c.rejected));
  const failure=correct!==null&&(severe!>0||leaks!>0||rewrites!>0||evidence.length>0&&correct/evidence.length<0.95)||archive.rejection_checks.some(c=>!c.rejected);
  return {subject_sha256:archive.explanation_subject_sha256,attestation_sha256:attestation,coverage,
    accuracy:correct===null?null:proportion(correct,evidence.length),severe_contradictions:severe,material_leaks:leaks,silent_answer_rewrites:rewrites,
    rejection_checks:archive.rejection_checks,assessment:failure?'thresholds_failed':!enough||!rejected||correct===null||!archive.completion.complete?'insufficient_evidence':'thresholds_met',
    release_ready:false};
}
