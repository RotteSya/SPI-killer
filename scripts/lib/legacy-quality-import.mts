import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {objectiveEvalAnswerHit} from '../../server/src/objective-eval-scoring.ts';
import {parseQualitySubmission,qualityDigest,type QualityCase,type QualitySubmission} from '../../server/src/quality.ts';

const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
type Json=Record<string,any>; // Historical archive schema is verified field by field below.
const fail=():never=>{throw new Error('Historical evaluation evidence does not match its reviewed artifacts');};
function equal(actual:unknown,expected:unknown){if(actual!==expected)fail();}
function integer(value:unknown):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>1_000_000_000)fail();return value as number;}
async function boundedFile(root:string,path:string):Promise<string>{
  const base=await realpath(root),file=await realpath(resolve(base,path));
  if(!file.startsWith(base+sep)||(await stat(file)).size>4*1024*1024)fail();return readFile(file,'utf8');
}
function manifest(root:string,commit:unknown):{text:string;data:Json}{
  if(typeof commit!=='string'||! /^[a-f0-9]{40}$/.test(commit))return fail();
  const text=execFileSync('git',['show',commit+':Tests/Fixtures/objective-v1/manifest.json'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
  const data=JSON.parse(text);if(data.schema_version!==1||!Array.isArray(data.fixtures)||data.fixtures.length!==240)fail();return {text,data};
}
function rows(text:string):Json[]{const result=text.trim().split(/\r?\n/).map(line=>JSON.parse(line));if(result.length!==240||new Set(result.map(r=>r.id)).size!==240)fail();return result;}
function verifyRows(records:Json[],fixtures:Json[],commit:string,model:string,baseline:boolean){
  const byId=new Map(fixtures.map(f=>[f.id,f]));
  for(const r of records){
    const f=byId.get(r.id)??fail();
    for(const key of ['kind','language','expected_state'])equal(r[key],f[key]);equal(r.commit,commit);equal(r.model,model);
    if(r.normalized_answer!==null&&typeof r.normalized_answer!=='string')fail();
    if(typeof r.normalized_answer==='string'&&[...r.normalized_answer].length>512)fail();
    integer(r.total_ms);integer(r.input_tokens);integer(r.output_tokens);
    if(!Array.isArray(f.accepted_answers)||!f.accepted_answers.every((a:unknown)=>typeof a==='string'))fail();
    equal(r.answer_hit,f.expected_state==='retake'?(baseline?null:r.actual_state==='retake'):objectiveEvalAnswerHit(r.normalized_answer,f.accepted_answers));
    if(!baseline){
      if(!['v1','legacy_fallback','none'].includes(r.parser_path))fail();equal(r.schema_valid,r.parser_path==='v1');
      if(!['ready','review','retake',null].includes(r.actual_state))fail();equal(r.state_match,r.actual_state===f.expected_state);
    }
  }
}
function verifySummary(summary:Json,records:Json[],baseline:boolean){
  const ratio=(rows:Json[],hit:(r:Json)=>boolean)=>rows.length?rows.filter(hit).length/rows.length:0;
  const answerable=records.filter(r=>r.expected_state!=='retake');equal(summary.calls,records.length);
  equal(summary.answerable_accuracy,ratio(answerable,r=>r.answer_hit===true));
  for(const dimension of ['kind','language'])for(const key of new Set(answerable.map(r=>r[dimension])))
    equal(summary['by_'+dimension]?.[key],ratio(answerable.filter(r=>r[dimension]===key),r=>r.answer_hit===true));
  equal(summary.avg_tokens,records.reduce((sum,r)=>sum+r.input_tokens+r.output_tokens,0)/records.length);
  equal(summary.p95_total_ms,records.map(r=>r.total_ms).sort((a,b)=>a-b)[Math.ceil(records.length*.95)-1]);
  if(!baseline){
    equal(summary.v1_valid_rate,ratio(records,r=>r.schema_valid));equal(summary.state_accuracy,ratio(records,r=>r.state_match));
    equal(summary.ready_precision,ratio(records.filter(r=>r.actual_state==='ready'),r=>r.expected_state==='ready'&&r.answer_hit));
    equal(summary.review_recall,ratio(records.filter(r=>r.expected_state==='review'),r=>r.actual_state==='review'));
    equal(summary.retake_recall,ratio(records.filter(r=>r.expected_state==='retake'),r=>r.actual_state==='retake'));
  }
}
export async function prepareLegacyQuality(options:{root:string;attestation:string;treatmentRows:string;baselineRows:string}):Promise<{submission:QualitySubmission;provenance:Json}>{
  const {root}=options,attestationText=await boundedFile(root,options.attestation),attestation=JSON.parse(attestationText);
  equal(attestation.schema_version,1);equal(attestation.status,'signed');
  for(const key of ['existing_240_call_treatment_record_reviewed','existing_240_call_baseline_record_reviewed','failed_items_not_rerun_for_selection','fixed_baseline_comparison_included'])equal(attestation.assertions?.[key],true);
  const artifact=async(name:string)=>{const reference=attestation.artifacts?.[name];if(!reference||typeof reference.path!=='string')return fail();
    const text=await boundedFile(root,reference.path);equal(digest(text),reference.sha256);return {text,data:JSON.parse(text),sha256:digest(text)};};
  const comparison=await artifact('comparison'),treatment=await artifact('treatment_summary'),baseline=await artifact('baseline_summary');
  const treatmentText=await boundedFile(root,options.treatmentRows),baselineText=await boundedFile(root,options.baselineRows);
  const treatmentRows=rows(treatmentText),baselineRows=rows(baselineText);
  const treatmentManifest=manifest(root,attestation.treatment_commit),baselineManifest=manifest(root,attestation.baseline_commit);
  const fixtureHash=(m:Json)=>digest(JSON.stringify({schema_version:m.schema_version,fixtures:m.fixtures}));
  equal(fixtureHash(treatmentManifest.data),fixtureHash(baselineManifest.data));equal(comparison.data.fixture_set_sha256,fixtureHash(treatmentManifest.data));
  equal(comparison.data.model,attestation.model);equal(comparison.data.treatment.commit,attestation.treatment_commit);equal(comparison.data.baseline.commit,attestation.baseline_commit);
  verifyRows(treatmentRows,treatmentManifest.data.fixtures,attestation.treatment_commit,attestation.model,false);
  verifyRows(baselineRows,baselineManifest.data.fixtures,attestation.baseline_commit,attestation.model,true);
  verifySummary(treatment.data,treatmentRows,false);verifySummary(baseline.data,baselineRows,true);
  for(const side of ['treatment','baseline'])for(const key of ['answerable_accuracy','avg_tokens','p95_total_ms'])
    equal(comparison.data[side][key],(side==='treatment'?treatment:baseline).data[key]);
  const only=(key:string)=>{const values=new Set(treatmentRows.map(r=>r[key]));if(values.size!==1)return fail();return [...values][0];};
  equal(only('prompt_version'),attestation.prompt_version);
  if(only('executor')===attestation.reviewer)fail();
  const cases:QualityCase[]=treatmentRows.map(r=>{
    const hasAnswer=typeof r.normalized_answer==='string'&&r.normalized_answer.length>0;
    return {case_sha256:digest('objective-v1:'+r.id),family_sha256:null,profile:'legacy_objective',kind:r.kind,language:r.language,
      layout:'single_image',expectation:r.expected_state==='retake'?'retake':'answerable',risk:'none',state:r.actual_state??'failed',parser_path:r.parser_path,protocol_valid:r.schema_valid,
      no_result_reason:null,has_answer:hasAnswer,answer_correct:hasAnswer?r.expected_state==='retake'?false:r.answer_hit:null,
      request_ms:r.total_ms,input_tokens:r.input_tokens,output_tokens:r.output_tokens};
  });
  const submission=parseQualitySubmission({schema_version:1,run:{id:attestation.comparison_id+'-treatment',dataset_id:'objective-v1',dataset_role:'legacy_regression',
    dataset_sha256:digest(treatmentManifest.text),results_sha256:digest(treatmentText),family_split_sha256:null,contract:'objective_v1',scope_version:attestation.prompt_version,
    model:attestation.model,commit:attestation.treatment_commit,app_version:only('app_version'),started_at:null,finished_at:treatment.data.generated_at,executor:only('executor'),expected_cases:240},
    declarations:[],cases,review:{reviewer:attestation.reviewer,reviewed_at:attestation.reviewed_at,attestation_sha256:digest(attestationText),binding:'legacy_summary_only',subject_sha256:comparison.sha256,
      labels_reviewed:false,results_reviewed:true,complete_run:true,no_selection_reruns:true,authorized_materials:false,family_split_verified:false}});
  return {submission,provenance:{mode:'offline_historical_import',paid_calls:0,source_attestation_sha256:digest(attestationText),comparison_sha256:comparison.sha256,
    treatment_summary_sha256:treatment.sha256,baseline_summary_sha256:baseline.sha256,treatment_rows_sha256:digest(treatmentText),baseline_rows_sha256:digest(baselineText),
    fixture_set_sha256:fixtureHash(treatmentManifest.data),prepared_submission_sha256:qualityDigest(submission),
    limitations:['original_attestation_binds_summaries_not_jsonl_bytes','historical_dataset_has_no_profile_or_family_labels','independent_label_review_not_explicit_in_legacy_attestation',
      'support_declarations_and_authorization_not_inferred_from_technical_review','not_current_screen_query_evidence']}};
}
