#!/usr/bin/env node
// Read-only evaluation inventory. Never loads database credentials or calls a model.
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callUpperCNY, validateEvaluationPolicy } from './lib/evaluation-budget.mts';
import {bytesSHA,evidenceJSON,loadReadingCorpus,readEvidenceFile} from './lib/reading-evaluation.mts';
import {validateReadingCandidate} from './lib/reading-runner.mts';
import {DatabaseSync} from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(await readFile(resolve(root, 'docs/evaluation-budget.json'), 'utf8'));
validateEvaluationPolicy(policy);
const blockers = [];
const datasets = [];
const fixturesRoot = resolve(root, 'Tests/Fixtures');
for (const entry of await readdir(fixturesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = resolve(fixturesRoot, entry.name, 'manifest.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const fixtures = manifest.fixtures ?? [];
    const hashFailures = [];
    let checkedImages = 0;
    for (const fixture of fixtures) {
      if (!fixture.image || !fixture.sha256) continue;
      const image = await readFile(resolve(dirname(manifestPath), fixture.image)).catch(() => null);
      checkedImages++;
      if (!image || createHash('sha256').update(image).digest('hex') !== fixture.sha256) hashFailures.push(fixture.id);
    }
    datasets.push({ name: entry.name, manifest: manifestPath, fixtures: fixtures.length, checked_images: checkedImages, hash_failures: hashFailures });
    if (hashFailures.length) blockers.push(`fixture_integrity_failed:${entry.name}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const readingCandidates = datasets.filter(row => /reading|阅读/iu.test(row.name)).map(row => row.manifest);
let readingCorpus={status:'missing'},loadedCorpus=null;
if (process.env.NSPI_READING_EVAL_MANIFEST) {
  const path = resolve(root, process.env.NSPI_READING_EVAL_MANIFEST);
  if ((await stat(path).catch(() => null))?.isFile()) readingCandidates.push(path);
  else blockers.push('configured_reading_manifest_missing');
  try {
    if(!process.env.NSPI_EVAL_EXECUTOR)throw new Error('Executor missing');
    loadedCorpus=await loadReadingCorpus(path,process.env.NSPI_EVAL_EXECUTOR);
    readingCorpus={status:'validated_review_claim',dataset_role:loadedCorpus.manifest.dataset_role,cases:loadedCorpus.manifest.cases.length,
      manifest_sha256:loadedCorpus.manifestSHA,planned_calls:loadedCorpus.manifest.cases.length+4*loadedCorpus.manifest.explanations_per_kind+2};
  }catch {readingCorpus={status:'invalid_or_unreviewed'};}
}
if(!loadedCorpus)blockers.push(readingCandidates.length ? 'reading_corpus_requires_authorization_and_independent_review' : 'reading_corpus_not_found');

function credentialState(value) {
  if (!value || !value.trim()) return 'missing';
  if (/\[SENSITIVE\]|\[REDACTED\]|placeholder|changeme|^<.+>$/iu.test(value)) return 'redacted_placeholder';
  return 'present_not_authenticated';
}
const localEnvironment = await readFile(resolve(root, 'server/.env.local'), 'utf8').catch(() => '');
const credentials = {};
for (const name of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY']) {
  const raw = localEnvironment.split(/\r?\n/u).find(line => line.startsWith(`${name}=`))?.slice(name.length + 1);
  credentials[name] = { process: credentialState(process.env[name]), local_file: credentialState(raw) };
}
credentials.NSPI_EVAL_DEVICE_TOKEN={process:credentialState(process.env.NSPI_EVAL_DEVICE_TOKEN)};
if(credentials.NSPI_EVAL_DEVICE_TOKEN.process!=='present_not_authenticated')blockers.push('isolated_evaluation_device_credential_missing');

let candidate=null,candidateEvidence={status:'missing'};
try {
  if(!loadedCorpus||!process.env.NSPI_EVAL_CANDIDATE_ATTESTATION||!process.env.NSPI_EVAL_CANDIDATE_EVIDENCE)throw new Error('Missing candidate evidence');
  candidate=validateReadingCandidate(evidenceJSON(await readEvidenceFile(resolve(root,process.env.NSPI_EVAL_CANDIDATE_ATTESTATION),1024*1024)),loadedCorpus.manifest.scope_version);
  const evidence=await readEvidenceFile(resolve(root,process.env.NSPI_EVAL_CANDIDATE_EVIDENCE),1024*1024);
  if(!evidence.length||bytesSHA(evidence)!==candidate.verification_sha256)throw new Error('Candidate evidence mismatch');
  candidateEvidence={status:'validated_operator_claim',commit:candidate.commit,app_version:candidate.app_version,model:candidate.model};
}catch {candidate=null;candidateEvidence={status:'missing_invalid_or_expired'};}
if(!candidate)blockers.push('reviewed_isolated_candidate_evidence_missing');

let costBound = { status: 'missing' };
if (process.env.NSPI_EVAL_COST_BOUND) {
  try {
    const bound = JSON.parse(await readFile(resolve(root, process.env.NSPI_EVAL_COST_BOUND), 'utf8'));
    const upper = callUpperCNY(bound, candidate?.model ?? process.env.NSPI_EVAL_MODEL ?? '', candidate?.base_url ?? process.env.NSPI_EVAL_BASE_URL ?? '');
    costBound = { status: 'valid', call_upper_cny_micros: upper };
  } catch { costBound = { status: 'invalid_or_expired' }; }
}
if (costBound.status !== 'valid') blockers.push('verified_candidate_cost_bound_missing');
let remaining=policy.limit_micros,ledgerStatus='not_created';
const ledgerPath=resolve(root,'.eval-results/budget-ledger.sqlite3');
if(await stat(ledgerPath).catch(()=>null)) {
  let ledger;
  try {
    ledger=new DatabaseSync(ledgerPath,{readOnly:true});
    const campaign=ledger.prepare('SELECT currency,limit_micros,halted FROM evaluation_campaigns WHERE id=?').get(policy.campaign_id);
    if(!campaign||campaign.currency!==policy.currency||campaign.limit_micros!==policy.limit_micros)throw new Error('Campaign mismatch');
    const used=ledger.prepare('SELECT COALESCE(SUM(upper_cny_micros),0) AS used FROM evaluation_dispatches WHERE campaign_id=?').get(policy.campaign_id).used;
    remaining=campaign.halted?0:Math.max(0,policy.limit_micros-Number(used));ledgerStatus=campaign.halted?'halted':'read_only_verified';
  }catch {remaining=null;ledgerStatus='unreadable_or_mismatched';blockers.push('shared_budget_ledger_requires_reconciliation');}finally {ledger?.close();}
}
if(costBound.status==='valid'&&loadedCorpus&&(remaining===null||costBound.call_upper_cny_micros*readingCorpus.planned_calls>remaining))blockers.push('whole_reading_run_exceeds_remaining_budget');
// This command validates inputs only; it never manufactures model results or reviewer signatures.
blockers.push('candidate_http_admission_and_real_quality_reviews_pending');

console.log(JSON.stringify({
  generated_at: new Date().toISOString(), mode: 'offline_read_only',
  budget: { campaign_id: policy.campaign_id, currency: policy.currency, limit_micros: policy.limit_micros,remaining_micros:remaining,ledger_status:ledgerStatus },
  existing_datasets: datasets, reading_candidates: [...new Set(readingCandidates)],
  reading_corpus:readingCorpus,candidate_evidence:candidateEvidence,credentials, cost_bound: costBound, blockers, paid_model_calls: 0,
  // Corpus presence, local compilation and historical SPI scores do not establish quality.
  reading_scope_release_ready: false,
}, null, 2));
process.exitCode = blockers.length ? 2 : 0;
