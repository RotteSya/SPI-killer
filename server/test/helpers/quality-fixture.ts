// Synthetic unit-test evidence only. Never imported by production code or counted as a real evaluation.
import {createHash} from 'node:crypto';
import {qualityReviewSubject,type QualityCase,type QualitySubmission} from '../../src/quality.ts';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function signFixture(input:QualitySubmission):QualitySubmission {
  input.review.subject_sha256=qualityReviewSubject(input);return input;
}
export function qualityFixture(id='synthetic-evaluation'):QualitySubmission {
  const cases:QualityCase[]=[],kinds=['single_choice','multiple_choice','ordering','short_fill'] as const;
  for(const kind of kinds)for(let i=0;i<100;i++)cases.push({case_sha256:hash(id+kind+i),family_sha256:hash('family:'+id+kind+i),profile:'reading_practice',kind,language:'ja',layout:'practice_ui',
    expectation:i<90?'answerable':'retake',risk:i<90?'none':'missing_context',state:i<90?'ready':'retake',parser_path:'v1',protocol_valid:true,no_result_reason:null,
    has_answer:i<90,answer_correct:i<90?true:null,request_ms:100+i,input_tokens:100,output_tokens:10});
  for(const expectation of ['out_of_scope','multiple_targets'] as const)for(let i=0;i<20;i++)cases.push({case_sha256:hash(id+expectation+i),family_sha256:hash('family:'+id+expectation+i),
    profile:'reading_practice',kind:'other',language:'ja',layout:'web',expectation,risk:'none',state:'no_result',parser_path:'screen_no_result',protocol_valid:true,
    no_result_reason:expectation==='out_of_scope'?'unsupported_scope':'multiple_targets',has_answer:false,answer_correct:null,request_ms:100,input_tokens:100,output_tokens:10});
  return signFixture({schema_version:1,run:{id,dataset_id:'synthetic-unit-test',dataset_role:'holdout',dataset_sha256:hash('dataset'),results_sha256:hash('results'),family_split_sha256:hash('split'),
    contract:'screen_query_v1',scope_version:'screen-query-v1-r1',model:'synthetic-model',commit:'a'.repeat(40),app_version:'2.12',started_at:'2026-08-01T00:00:00.000Z',
    finished_at:'2026-08-01T01:00:00.000Z',executor:'test-executor',expected_cases:cases.length},
    declarations:kinds.map(kind=>({profile:'reading_practice',kind,language:'ja'})),cases,
    review:{reviewer:'test-reviewer',reviewed_at:'2026-08-02T00:00:00.000Z',attestation_sha256:hash('test-attestation'),binding:'case_digest',subject_sha256:'',
      labels_reviewed:true,results_reviewed:true,complete_run:true,no_selection_reruns:true,authorized_materials:true,family_split_verified:true}});
}
