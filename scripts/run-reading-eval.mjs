#!/usr/bin/env node
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readEvidenceFile,loadReadingCorpus,evidenceJSON} from './lib/reading-evaluation.mts';
import {runReadingEvaluation,validateReadingCandidate} from './lib/reading-runner.mts';
import {openEvaluationBudget} from './lib/evaluation-budget.mts';
import {openEvaluationAccess} from './lib/evaluation-access.mts';

async function main() {
  if(process.env.NSPI_RUN_READING_EVAL!=='1')throw new Error('Set NSPI_RUN_READING_EVAL=1 only for an authorized isolated full-corpus evaluation');
  const required=['NSPI_READING_EVAL_MANIFEST','NSPI_EVAL_CANDIDATE_ATTESTATION','NSPI_EVAL_CANDIDATE_EVIDENCE','NSPI_EVAL_DEVICE_TOKEN','NSPI_EVAL_EXECUTOR','NSPI_READING_EVAL_OUT'];
  for(const name of required)if(!process.env[name])throw new Error(name+' is required');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const corpus=await loadReadingCorpus(resolve(root,process.env.NSPI_READING_EVAL_MANIFEST),process.env.NSPI_EVAL_EXECUTOR);
  const candidateBytes=await readEvidenceFile(resolve(root,process.env.NSPI_EVAL_CANDIDATE_ATTESTATION),1024*1024);
  const candidate=validateReadingCandidate(evidenceJSON(candidateBytes),corpus.manifest.scope_version);
  const candidateEvidenceBytes=await readEvidenceFile(resolve(root,process.env.NSPI_EVAL_CANDIDATE_EVIDENCE),1024*1024);
  const budget=openEvaluationBudget(root,candidate.model,candidate.base_url);
  try {
    const evaluationAccess=await openEvaluationAccess(candidate.base_url,process.env.NSPI_EVAL_VERCEL_SHARE_TOKEN);
    const completion=await runReadingEvaluation({corpus,candidate,budget,evaluationAccess,executor:process.env.NSPI_EVAL_EXECUTOR,
      deviceToken:process.env.NSPI_EVAL_DEVICE_TOKEN,outputDir:resolve(root,process.env.NSPI_READING_EVAL_OUT),candidateBytes,candidateEvidenceBytes,
      progress:(done,total)=>console.log('Reading evaluation cases: '+done+'/'+total)});
    console.log(JSON.stringify({complete:completion.complete,answer_cases:completion.answer_cases,explanation_calls:completion.explanation_calls,
      halt_reason:completion.halt_reason,review_subject_sha256:completion.review_subject_sha256,release_ready:false}));
    if(!completion.complete)process.exitCode=2;
  } finally {budget.close();}
}
main().catch(()=>{console.error('Reading evaluation stopped. Verify the explicit inputs, corpus authorization, candidate evidence and budget; existing output is never overwritten.');process.exitCode=2;});
