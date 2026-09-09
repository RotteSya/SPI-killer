import {randomUUID} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {qualityDigest,qualityReviewSubject,type QualityCase,type QualityRun} from '../../server/src/quality.ts';
import {composeScreenQuery} from '../../server/src/screen-query.ts';
import type {EvaluationAccess} from './evaluation-access.mts';
import type {EvaluationBudget} from './evaluation-budget.mts';
import {ReadingEvidenceError,bytesSHA,evidenceJSON,corpusFile,readingImages,parseReadingStream,scoreReadingCase,
  type LoadedReadingCorpus,type ReadingCase,type ReadingDraft,type ReadingStream} from './reading-evaluation.mts';

export interface ReadingCandidate {
  schema_version:1;base_url:string;model:string;commit:string;app_version:string;scope_version:string;
  config_revision:string;isolated:true;verified_by:string;verified_at:string;expires_at:string;verification_sha256:string;
}
export function validateReadingCandidate(raw:unknown,scopeVersion:string,now=Date.now()):ReadingCandidate {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ReadingEvidenceError('Candidate attestation required');
  const c=raw as ReadingCandidate;
  if(Object.keys(c).sort().join(',')!==['schema_version','base_url','model','commit','app_version','scope_version','config_revision','isolated','verified_by','verified_at','expires_at','verification_sha256'].sort().join(',')||
    c.schema_version!==1||c.isolated!==true||c.scope_version!==scopeVersion||! /^[a-f0-9]{40}$/.test(c.commit)||! /^[a-f0-9]{64}$/.test(c.verification_sha256))
    throw new ReadingEvidenceError('Candidate identity or isolation attestation invalid');
  for(const field of ['model','app_version','config_revision','verified_by'] as const)if(typeof c[field]!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,149}$/.test(c[field]))throw new ReadingEvidenceError('Invalid candidate metadata');
  if(c.app_version.length>64)throw new ReadingEvidenceError('Candidate app version too long');
  const url=new URL(c.base_url),verified=Date.parse(c.verified_at),expires=Date.parse(c.expires_at);
  if(url.username||url.password||url.search||url.hash||
    (url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))||
    !Number.isFinite(verified)||!Number.isFinite(expires)||new Date(verified).toISOString()!==c.verified_at||new Date(expires).toISOString()!==c.expires_at||verified>now||expires<=now||expires<=verified||expires-verified>86_400_000)
    throw new ReadingEvidenceError('Candidate requires HTTPS/loopback and verification within 24 hours');
  return {...c,base_url:url.href.replace(/\/+$/u,'')};
}
export async function writeReadingArtifact(path:string,value:unknown):Promise<string> {
  const body=JSON.stringify(value,null,2)+'\n',file=await open(path,'wx',0o600);
  try {await file.writeFile(body);await file.sync();}finally{await file.close();}
  return bytesSHA(body);
}
export interface ReadingResponse {
  schema_version:1;case_id:string;capture_id:string;parent_capture_id:string|null;purpose:'answer'|'explain'|'explain_rejection';
  dispatch_id:string;upper_cny_micros:number|null;started_at:string;finished_at:string;request_ms:number;
  http_status:number|null;content_type:string|null;failure:'not_dispatched'|'transport_failed'|null;body:string;
}
export interface ReadingResponseIndex {file:string;sha256:string;case_id:string;capture_id:string;purpose:ReadingResponse['purpose']}
export interface ReadingRunPlan {
  schema_version:1;run_id:string;started_at:string;executor:string;candidate:ReadingCandidate;candidate_sha256:string;
  manifest_sha256:string;family_split_sha256:string;corpus_review_sha256:string;
  cost_bound_sha256:string;budget_policy_sha256:string;
  planned_cases:Array<{case_id:string;capture_id:string}>;
  explanation_policy:{per_kind:number;selection:'first_usable_in_manifest_order';rejection_checks:2};
  budget:{calls:number;upper_cny_micros:number;remaining_cny_micros:number};
  admission:{checked_at:string;account_balance:number;config_revision:string;provider:string};
}
export interface ReadingCompletion {
  schema_version:1;plan_sha256:string;finished_at:string;complete:boolean;halt_reason:string|null;
  results_sha256:string;draft_sha256:string;review_subject_sha256:string;
  answer_cases:number;explanation_calls:number;rejection_checks:number;
  unresolved_dispatches:number;
}
async function candidateJSON(base:string,path:string,token:string,access?:EvaluationAccess):Promise<Record<string,unknown>> {
  const response=await fetch(base+path,{headers:{...access?.headersFor(base+path),authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15_000)});
  if(!response.ok||response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json') {
    await response.body?.cancel();throw new ReadingEvidenceError('Candidate preflight refused');
  }
  const chunks:Uint8Array[]=[];let size=0;
  if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>65_536)throw new ReadingEvidenceError('Candidate preflight response too large');chunks.push(chunk);}
  let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ReadingEvidenceError('Candidate preflight JSON invalid');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new ReadingEvidenceError('Candidate preflight body invalid');return data as Record<string,unknown>;
}
async function admitCandidate(corpus:LoadedReadingCorpus,candidate:ReadingCandidate,token:string,access?:EvaluationAccess):Promise<ReadingRunPlan['admission']> {
  const account=await candidateJSON(candidate.base_url,'/v1/account',token,access),configuration=await candidateJSON(candidate.base_url,'/v1/client-config',token,access);
  const health=await candidateJSON(candidate.base_url,'/healthz',token,access),screen=configuration.screen_query as Record<string,unknown>|undefined;
  const objective=configuration.objective_result_v1 as Record<string,unknown>|undefined;
  if(typeof account.balance_questions!=='number'||!Number.isSafeInteger(account.balance_questions)||account.balance_questions<corpus.manifest.cases.length||account.held_questions!==0)
    throw new ReadingEvidenceError('Isolated device needs enough quota and no in-flight capture');
  if(configuration.revision!==candidate.config_revision||objective?.protocol!=='objective_v1'||screen?.support_revision!==corpus.manifest.scope_version||
    !Array.isArray(screen.capabilities)||!screen.capabilities.includes('screen_query_v1')||!Array.isArray(screen.enabled_profiles)||!screen.enabled_profiles.includes('reading_practice'))
    throw new ReadingEvidenceError('Candidate configuration differs from the frozen evaluation');
  const provider=health.objective_provider==='inherit'?health.provider:health.objective_provider;
  if(health.ok!==true||health.objective_provider_error!==undefined||typeof provider!=='string'||corpus.manifest.dataset_role==='holdout'&&!['anthropic','deepseek','openai'].includes(provider))
    throw new ReadingEvidenceError('Holdout requires a healthy real provider');
  return {checked_at:new Date().toISOString(),account_balance:account.balance_questions,config_revision:candidate.config_revision,provider};
}
export function draftReadingRun(corpus:LoadedReadingCorpus,plan:ReadingRunPlan,rows:ReadingResponse[],resultsSHA:string,finishedAt:string):ReadingDraft {
  const planned=new Map(plan.planned_cases.map(c=>[c.case_id,c.capture_id]));
  const answers=rows.filter(row=>row.purpose==='answer');
  if(new Set(answers.map(r=>r.case_id)).size!==answers.length)throw new ReadingEvidenceError('Duplicate answer result');
  const cases=answers.map(row=>{
    const item=corpus.manifest.cases.find(c=>c.id===row.case_id);
    if(!item||planned.get(row.case_id)!==row.capture_id)throw new ReadingEvidenceError('Unplanned answer result');
    let stream:ReadingStream|null=null;
    if(row.http_status===200&&!row.failure&&row.content_type?.split(';')[0]?.trim().toLowerCase()==='text/event-stream') {
      try {stream=parseReadingStream(row.body,row.capture_id);}catch{/* Keep the failed case in the denominator. */}
    }
    return scoreReadingCase(corpus,item,stream,row.request_ms);
  });
  const run:QualityRun={id:plan.run_id,dataset_id:corpus.manifest.dataset_id,dataset_role:corpus.manifest.dataset_role,
    dataset_sha256:corpus.manifestSHA,results_sha256:resultsSHA,family_split_sha256:corpus.manifest.family_split.sha256,
    contract:'screen_query_v1',scope_version:corpus.manifest.scope_version,model:plan.candidate.model,commit:plan.candidate.commit,
    app_version:plan.candidate.app_version,started_at:plan.started_at,finished_at:finishedAt,executor:plan.executor,expected_cases:corpus.manifest.cases.length};
  return {schema_version:1,run,declarations:corpus.manifest.declarations,cases};
}

export async function runReadingEvaluation(input:{corpus:LoadedReadingCorpus;candidate:ReadingCandidate;budget:EvaluationBudget;
  evaluationAccess?:EvaluationAccess;executor:string;deviceToken:string;outputDir:string;candidateBytes:Buffer;candidateEvidenceBytes:Buffer;progress?:(completed:number,total:number)=>void}):Promise<ReadingCompletion> {
  const {corpus,budget,executor}=input,candidate=validateReadingCandidate(input.candidate,corpus.manifest.scope_version);
  const bound=budget.candidateIdentity();
  if(bound.model!==candidate.model||bound.baseURL!==candidate.base_url||input.candidateBytes.length>1024*1024||
    !input.candidateEvidenceBytes.length||input.candidateEvidenceBytes.length>1024*1024||bytesSHA(input.candidateEvidenceBytes)!==candidate.verification_sha256||
    qualityDigest(validateReadingCandidate(evidenceJSON(input.candidateBytes),corpus.manifest.scope_version))!==qualityDigest(candidate))throw new ReadingEvidenceError('Candidate and budget/evidence binding differ');
  if(! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(executor)||executor.toLowerCase()===corpus.review.reviewer.toLowerCase())throw new ReadingEvidenceError('Independent corpus reviewer must differ from executor');
  if(!input.deviceToken||input.deviceToken.length>512||/[\s\r\n]|\[SENSITIVE\]|\[REDACTED\]|placeholder|changeme/i.test(input.deviceToken))throw new ReadingEvidenceError('An isolated evaluation device credential is required');
  const totalCalls=corpus.manifest.cases.length+4*corpus.manifest.explanations_per_kind+2;
  budget.checkWholeRun(totalCalls);
  const admission=await admitCandidate(corpus,candidate,input.deviceToken,input.evaluationAccess);
  validateReadingCandidate(candidate,corpus.manifest.scope_version);
  if(Date.parse(corpus.review.expires_at)<=Date.now())throw new ReadingEvidenceError('Corpus authorization expired during admission');
  const allocation=budget.checkWholeRun(totalCalls);
  const output=resolve(input.outputDir);
  await mkdir(dirname(output),{recursive:true,mode:0o700});await mkdir(output,{mode:0o700});await mkdir(resolve(output,'responses'),{mode:0o700});
  const runID='reading-'+randomUUID(),startedAt=new Date().toISOString();
  const cost=budget.costEvidence(),costSHA=await writeReadingArtifact(resolve(output,'cost-bound.json'),cost.bound),policySHA=await writeReadingArtifact(resolve(output,'budget-policy.json'),cost.policy);
  const plan:ReadingRunPlan={schema_version:1,run_id:runID,started_at:startedAt,executor,candidate,candidate_sha256:bytesSHA(input.candidateBytes),
    manifest_sha256:corpus.manifestSHA,family_split_sha256:corpus.manifest.family_split.sha256,corpus_review_sha256:corpus.manifest.authorization_review.sha256,
    cost_bound_sha256:costSHA,budget_policy_sha256:policySHA,
    planned_cases:corpus.manifest.cases.map(c=>({case_id:c.id,capture_id:randomUUID()})),
    explanation_policy:{per_kind:corpus.manifest.explanations_per_kind,selection:'first_usable_in_manifest_order',rejection_checks:2},budget:allocation,admission};
  // Freeze source bytes before the first dispatch. Raw material is not copied into the app.
  const manifestFile=await open(resolve(output,'manifest.json'),'wx',0o600);
  try {await manifestFile.writeFile(corpus.manifestBytes);await manifestFile.sync();}finally{await manifestFile.close();}
  for(const [name,data] of [['candidate.json',input.candidateBytes],['candidate-evidence.bin',input.candidateEvidenceBytes]] as const) {
    const file=await open(resolve(output,name),'wx',0o600);
    try {await file.writeFile(data);await file.sync();}finally{await file.close();}
  }
  for(const [name,ref] of [['family-split.json',corpus.manifest.family_split],['corpus-review.json',corpus.manifest.authorization_review]] as const) {
    const data=await corpusFile(corpus.root,ref,1024*1024),file=await open(resolve(output,name),'wx',0o600);
    try {await file.writeFile(data);await file.sync();}finally{await file.close();}
  }
  const planSHA=await writeReadingArtifact(resolve(output,'run.json'),plan),rows:ReadingResponse[]=[],index:ReadingResponseIndex[]=[],answerScores:QualityCase[]=[];
  let dispatches=0;
  const selected=new Map<string,number>(),rejectionStates=new Set<string>();let halt:string|null=null;
  const call=async(item:ReadingCase,images:string[],purpose:ReadingResponse['purpose'],captureID:string,parentID:string|null,answer:string|null):Promise<ReadingResponse>=>{
    validateReadingCandidate(candidate,corpus.manifest.scope_version);
    if(Date.parse(corpus.review.expires_at)<=Date.now())throw new ReadingEvidenceError('Corpus authorization expired');
    const dispatchID=randomUUID(),path=parentID?`/v1/captures/${parentID}/explanation`:'/v1/captures';
    const body=JSON.stringify({capture_id:captureID,result_protocol:'objective_v1',response_contract:'screen_query_v1',operation:'solve',
      profile_id:'reading_practice',profile_version:corpus.manifest.scope_version,prompt_version:corpus.manifest.scope_version,ui_language:item.language,
      images_base64:images,image_base64:images.at(-1),image_media_type:item.image_media_type,scope:item.scope,
      ...(parentID?{explanation_id:captureID,final_answer:answer??''}:{})});
    if(Buffer.byteLength(body)>12*1024*1024)throw new ReadingEvidenceError('Corpus request exceeds 12 MiB');
    const started=performance.now(),at=new Date().toISOString();
    await writeReadingArtifact(resolve(output,'responses',dispatchID+'.dispatch.json'),{schema_version:1,case_id:item.id,capture_id:captureID,
      parent_capture_id:parentID,dispatch_id:dispatchID,purpose,started_at:at});
    dispatches++;
    let status:number|null=null,contentType:string|null=null,responseBody='',failure:ReadingResponse['failure']=null;
    try {
      const response=await budget.fetchText(path,{method:'POST',headers:{...input.evaluationAccess?.headersFor(candidate.base_url+path),authorization:'Bearer '+input.deviceToken,
        'content-type':'application/json','x-app-version':candidate.app_version},body},item.id,purpose==='answer'?'answer':'explain',dispatchID);
      status=response.status;contentType=response.contentType;responseBody=response.body;
    } catch {failure=budget.dispatchEvidence(dispatchID)?'transport_failed':'not_dispatched';if(failure==='not_dispatched')halt='budget_or_dispatch_gate';}
    const row:ReadingResponse={schema_version:1,case_id:item.id,capture_id:captureID,parent_capture_id:parentID,purpose,dispatch_id:dispatchID,
      upper_cny_micros:budget.dispatchEvidence(dispatchID)?.upperCNYMicros??null,started_at:at,finished_at:new Date().toISOString(),
      request_ms:Math.round(performance.now()-started),http_status:status,content_type:contentType,failure,body:responseBody};
    const file='responses/'+dispatchID+'.json',digest=await writeReadingArtifact(resolve(output,file),row);
    // Raw bodies stay in private files; the full corpus must not accumulate them in RAM.
    rows.push({...row,body:''});index.push({file,sha256:digest,case_id:item.id,capture_id:captureID,purpose});
    if(status===200) {
      try {const stream=parseReadingStream(responseBody,captureID,parentID?'explain':'solve');budget.observeUsage(dispatchID,stream.receipt.input_tokens,stream.receipt.output_tokens);}
      catch {if(budget.remainingMicros()===0)halt='cost_bound_or_budget_halt';}
    }
    if(status!==null&&[401,402,403,404,409,413,429,503].includes(status)&&purpose!=='explain_rejection')halt='candidate_or_service_rejected';
    return row;
  };
  for(const [position,item] of corpus.manifest.cases.entries()) {
    if(halt)break;
    try {
      const images=await readingImages(corpus,item),id=plan.planned_cases[position]!.capture_id;
      const row=await call(item,images,'answer',id,null,null);
      let stream:ReadingStream|null=null;
      try {if(row.http_status===200&&!row.failure&&row.content_type?.split(';')[0]?.trim().toLowerCase()==='text/event-stream')stream=parseReadingStream(row.body,id);}catch{/* Failed case stays recorded; never retry it. */}
      const score=scoreReadingCase(corpus,item,stream,row.request_ms),parsed=stream?composeScreenQuery(stream.raw):null;
      answerScores.push(score);
      if(!halt&&score.has_answer&&item.expectation==='answerable'&&item.kind!=='other'&&(selected.get(item.kind)??0)<corpus.manifest.explanations_per_kind) {
        selected.set(item.kind,(selected.get(item.kind)??0)+1);
        await call(item,images,'explain',randomUUID(),id,parsed!.objective.finalAnswer);
      } else if(!halt&&stream&&['retake','no_result'].includes(stream.receipt.terminal_state)&&!rejectionStates.has(stream.receipt.terminal_state)) {
        rejectionStates.add(stream.receipt.terminal_state);
        const rejection=await call(item,images,'explain_rejection',randomUUID(),id,null);
        let code:unknown;try{code=(JSON.parse(rejection.body) as {error?:{code?:unknown}}).error?.code;}catch{/* Reject an ambiguous refusal. */}
        if(rejection.http_status!==409||code!=='binding_mismatch')halt='explanation_rejection_contract_failed';
      }
      input.progress?.(position+1,corpus.manifest.cases.length);
    } catch {halt='input_or_artifact_integrity_failed';}
  }
  const finishedAt=new Date().toISOString();
  if(!halt&&(Date.parse(finishedAt)>=Date.parse(candidate.expires_at)||Date.parse(finishedAt)>=Date.parse(corpus.review.expires_at)))halt='authorization_or_candidate_expired_during_run';
  const resultsSHA=await writeReadingArtifact(resolve(output,'results.json'),index);
  const draft={...draftReadingRun(corpus,plan,[],resultsSHA,finishedAt),cases:answerScores},draftSHA=await writeReadingArtifact(resolve(output,'quality-draft.json'),draft);
  const completion:ReadingCompletion={schema_version:1,plan_sha256:planSHA,finished_at:finishedAt,
    complete:!halt&&draft.cases.length===corpus.manifest.cases.length,halt_reason:halt,results_sha256:resultsSHA,draft_sha256:draftSHA,
    review_subject_sha256:qualityReviewSubject(draft),answer_cases:draft.cases.length,
    unresolved_dispatches:dispatches-index.length,
    explanation_calls:rows.filter(r=>r.purpose==='explain').length,rejection_checks:rows.filter(r=>r.purpose==='explain_rejection').length};
  await writeReadingArtifact(resolve(output,'completion.json'),completion);
  return completion;
}
