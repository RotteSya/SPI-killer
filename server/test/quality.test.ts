import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aggregateQuality,parseQualitySubmission,QualityValidationError,parseQualityList,qualityDigest} from '../src/quality.ts';
import {qualityFixture,signFixture} from './helpers/quality-fixture.ts';

test('independent quality uses case denominators and Wilson intervals, without issuing release approval',()=>{
  const input=parseQualitySubmission(qualityFixture()),report=aggregateQuality(input);
  assert.equal(report.overall.samples,440);assert.equal(report.overall.strict_usable_precision.denominator,360);
  assert.equal(report.overall.strict_usable_precision.numerator,360);assert.equal(report.overall.strict_usable_precision.confidence_interval_95?.method,'Wilson');
  assert.equal(report.overall.declared_scope_coverage.denominator,360);assert.equal(report.overall.retake_recall.denominator,40);
  assert.equal(report.overall.out_of_scope_recognition.denominator,20);assert.equal(report.cells.length,5);
  assert.equal(report.assessment,'thresholds_met');assert.match(report.release_interpretation,/requires_exact_candidate_binding/);
  assert.doesNotMatch(JSON.stringify(report),/case_sha256|family_sha256|normalized_answer|accepted_answers/);
});
test('rejecting every answer cannot improve coverage or answerable accuracy into a passing gate',()=>{
  const input=qualityFixture();for(const c of input.cases)if(c.expectation==='answerable'){c.state='retake';c.has_answer=false;c.answer_correct=null;}
  const report=aggregateQuality(parseQualitySubmission(signFixture(input)));
  assert.equal(report.overall.declared_scope_coverage.rate,0);assert.equal(report.overall.answerable_accuracy.rate,0);
  assert.equal(report.overall.strict_usable_precision.rate,null);assert.equal(report.assessment,'thresholds_failed');
});
test('missing truth prevents a precision claim and fallback results remain separate from strict V1',()=>{
  const input=qualityFixture(),first=input.cases[0]!,second=input.cases[1]!;
  first.expectation='unlabelled';first.answer_correct=null;second.parser_path='legacy_fallback';second.protocol_valid=false;second.state='review';
  const report=aggregateQuality(parseQualitySubmission(signFixture(input)));
  assert.equal(report.overall.strict_usable_precision.rate,null);assert.equal(report.overall.strict_usable_precision.unlabelled,1);
  assert.equal(report.overall.strict_usable_precision.denominator,359);assert.equal(report.overall.legacy_fallback_precision.denominator,1);
  assert.equal(report.overall.legacy_fallback_precision.rate,1);assert.ok(report.evidence_gaps.includes('unlabelled_cases'));
  assert.equal(report.overall.strict_scope_coverage.numerator,358);
});
test('scope and multi-target diagnostics are independently scored; wrong refusal reason is not a success',()=>{
  const input=qualityFixture(),out=input.cases.filter(c=>c.expectation==='out_of_scope');
  out[0]!.no_result_reason='multiple_targets';out[1]!.no_result_reason='multiple_targets';
  const report=aggregateQuality(parseQualitySubmission(signFixture(input)));
  assert.equal(report.overall.protocol_valid.rate,1);assert.equal(report.overall.out_of_scope_recognition.rate,.9);
  assert.equal(report.overall.multiple_target_recognition.rate,1);assert.equal(report.assessment,'thresholds_failed');
});
test('partial executions report missing cases and cannot assert a complete run',()=>{
  const input=qualityFixture();input.cases=input.cases.slice(0,50);
  assert.throws(()=>parseQualitySubmission(signFixture(input)),QualityValidationError);
  input.review.complete_run=false;const report=aggregateQuality(parseQualitySubmission(signFixture(input)));
  assert.equal(report.execution.missing_cases,390);assert.ok(report.evidence_gaps.includes('complete_run'));
  assert.notEqual(report.assessment,'thresholds_met');
});
test('evidence rejects altered review subjects, repeated cases, impossible states, free text and same reviewer',()=>{
  const unchanged=qualityFixture();assert.equal(qualityDigest(unchanged),qualityDigest(Object.fromEntries(Object.entries(unchanged).reverse())));
  for(const change of [
    (i:ReturnType<typeof qualityFixture>)=>{i.cases[0]!.answer_correct=false;},
    (i:ReturnType<typeof qualityFixture>)=>{i.cases[1]!.case_sha256=i.cases[0]!.case_sha256;},
    (i:ReturnType<typeof qualityFixture>)=>{i.cases[0]!.state='failed';},
    (i:ReturnType<typeof qualityFixture>)=>{i.cases[0]!.parser_path='legacy_fallback';i.cases[0]!.protocol_valid=false;signFixture(i);},
    (i:ReturnType<typeof qualityFixture>)=>{i.review.reviewer=i.run.executor.toUpperCase();},
  ]){const input=qualityFixture();change(input);assert.throws(()=>parseQualitySubmission(input),QualityValidationError);}
  assert.throws(()=>parseQualitySubmission({...unchanged,question:'private text'}),QualityValidationError);
  for(const raw of [{profile:'not-real'},{limit:'0'},{before_revision:'9223372036854775808'},{contract:['objective_v1']},{source:'spi_entry'}])assert.throws(()=>parseQualityList(raw),QualityValidationError);
});
test('SPI, undeclared and unlabelled cases cannot fill the new non-SPI sample budget',()=>{
  for(const change of [
    (i:ReturnType<typeof qualityFixture>)=>{i.cases[0]!.profile='spi';i.declarations.push({profile:'spi',kind:'single_choice',language:'ja'});},
    (i:ReturnType<typeof qualityFixture>)=>{i.cases[0]!.language='en';},
    (i:ReturnType<typeof qualityFixture>)=>{i.cases[0]!.expectation='unlabelled';i.cases[0]!.answer_correct=null;},
  ]){const input=qualityFixture();change(input);const report=aggregateQuality(parseQualitySubmission(signFixture(input)));
    assert.equal(report.new_scope_sample_counts.samples,399);assert.equal(report.new_scope_sample_counts.by_kind.single_choice,99);
    assert.ok(report.evidence_gaps.includes('holdout_below_400'));assert.ok(report.evidence_gaps.includes('kind_below_100:single_choice'));
    assert.notEqual(report.assessment,'thresholds_met');}
});
test('legacy summary attestations cannot be rebound to screen-query evidence and do not establish byte-level case review',()=>{
  const input=qualityFixture();input.review.binding='legacy_summary_only';
  assert.throws(()=>parseQualitySubmission(input),QualityValidationError);
  input.run.dataset_role='legacy_regression';input.run.contract='objective_v1';input.cases=input.cases.filter(c=>c.parser_path==='v1');input.run.expected_cases=input.cases.length;
  input.cases.forEach(c=>{c.profile='legacy_objective';});input.declarations=[];
  const report=aggregateQuality(parseQualitySubmission(input));
  assert.ok(report.evidence_gaps.includes('review_does_not_bind_scored_case_bytes'));
  assert.ok(report.evidence_gaps.includes('not_screen_query_contract'));assert.equal(report.assessment,'insufficient_evidence');
});
