import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareLegacyQuality} from '../../scripts/lib/legacy-quality-import.mts';
import {aggregateQuality} from '../src/quality.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),attestation='objective-eval-output/2026-08-31T13-25-50.386Z-r5-vs-legacy-attestation.json';
const options={root,attestation,treatmentRows:'objective-eval-output/2026-08-31T13-20-54.674Z.jsonl',baselineRows:'objective-eval-output/2026-08-31T13-06-26.590Z-legacy.jsonl'};
// Historical private archives are optional checkout assets; local release verification runs
// this integration when available. No model calls or changes to the original records.
test('historical import recomputes 240 cases, keeps profile/family uncertainty and rejects tampering',{skip:!existsSync(resolve(root,attestation))},async()=>{
  const result=await prepareLegacyQuality(options),report=aggregateQuality(result.submission);
  assert.equal(report.overall.samples,240);assert.equal(report.overall.answerable_accuracy.numerator,197);assert.equal(report.overall.answerable_accuracy.denominator,204);
  assert.equal(report.cells.length,12);assert.ok(report.cells.every(c=>c.profile==='legacy_objective'));
  assert.equal(report.declarations.length,0);assert.equal(report.overall.declared_scope_coverage.rate,null);assert.equal(report.review.labels_reviewed,false);
  assert.equal(report.overall.families,null);assert.equal(report.overall.unlabelled_families,240);assert.equal(result.provenance.paid_calls,0);
  const dir=await mkdtemp(join(root,'.quality-import-test-'));
  try{
    const changed=JSON.parse(await readFile(resolve(root,attestation),'utf8'));changed.artifacts.comparison.sha256='0'.repeat(64);
    const badAttestation=join(dir,'attestation.json');await writeFile(badAttestation,JSON.stringify(changed));
    await assert.rejects(()=>prepareLegacyQuality({...options,attestation:badAttestation}));
    const rows=(await readFile(resolve(root,options.treatmentRows),'utf8')).trim().split('\n').map(line=>JSON.parse(line));rows[0].normalized_answer='wrong';
    const badRows=join(dir,'rows.jsonl');await writeFile(badRows,rows.map(r=>JSON.stringify(r)).join('\n'));
    await assert.rejects(()=>prepareLegacyQuality({...options,treatmentRows:badRows}));
  }finally{await rm(dir,{recursive:true,force:true});}
});
