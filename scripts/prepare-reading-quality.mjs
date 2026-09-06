#!/usr/bin/env node
// No network or model credentials. Inspection produces unsigned review subjects only.
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadReadingArchive,prepareReadingQuality} from './lib/reading-quality.mts';
import {writeReadingArtifact} from './lib/reading-runner.mts';

async function main() {
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2) {
    const key=args[i],value=args[i+1];
    if(!['--run','--review','--explanation-review','--out'].includes(key)||!value||options[key])throw new Error('Invalid arguments');
    options[key]=value;
  }
  if(!options['--run'])throw new Error('--run is required');
  if(!options['--review']) {
    if(options['--out']||options['--explanation-review'])throw new Error('Output requires an independent review');
    const archive=await loadReadingArchive(resolve(options['--run']));
    console.log(JSON.stringify({complete:archive.completion.complete,answer_cases:archive.draft.cases.length,
      review_subject_sha256:archive.completion.review_subject_sha256,explanation_subject_sha256:archive.explanation_subject_sha256,
      explanations:archive.explanations,rejection_checks:archive.rejection_checks,cost_bounds:archive.cost_bounds,release_ready:false},null,2));
    return;
  }
  if(!options['--out'])throw new Error('--out is required with --review');
  const result=await prepareReadingQuality(resolve(options['--run']),resolve(options['--review']),
    options['--explanation-review']?resolve(options['--explanation-review']):undefined);
  const output=resolve(options['--out']);await mkdir(output,{mode:0o700});
  await writeReadingArtifact(resolve(output,'submission.json'),result.submission);
  await writeReadingArtifact(resolve(output,'report.json'),result.report);
  await writeReadingArtifact(resolve(output,'provenance.json'),result.provenance);
  console.log(JSON.stringify({output,cases:result.submission.cases.length,quality:result.report.assessment,
    explanations:result.provenance.explanations.assessment,paid_calls:0,release_ready:false}));
}
main().catch(()=>{console.error('Offline reading review refused: verify archive integrity, independent review bindings and a new output directory.');process.exitCode=2;});
