import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Fastify from 'fastify';
import {config} from '../src/config.ts';
import {registerRoutes} from '../src/routes.ts';
import {MemoryStore} from '../src/db-memory.ts';
import {SqliteStore} from '../src/db-sqlite.ts';
import {StubPaymentProvider} from '../src/payments.ts';
import {qualityReviewSubject} from '../src/quality.ts';
import {pngBytes} from './helpers/images.ts';
import {SCREEN_QUERY_VERSION,composeScreenQuery} from '../src/screen-query.ts';
import {EvaluationBudget,type EvaluationCallBound} from '../../scripts/lib/evaluation-budget.mts';
import {bytesSHA,loadReadingCorpus,parseReadingManifest,parseReadingStream,readingManifestSubject,scoreReadingCase,
  type ReadingManifest,type ReadingCase} from '../../scripts/lib/reading-evaluation.mts';
import {runReadingEvaluation,type ReadingCandidate} from '../../scripts/lib/reading-runner.mts';
import {loadReadingArchive,prepareReadingQuality} from '../../scripts/lib/reading-quality.mts';

// Synthetic diagnostics stay in temporary test directories and never count as product evidence.
const at=()=>new Date().toISOString(),future=()=>new Date(Date.now()+3600_000).toISOString();
const kinds=['single_choice','multiple_choice','ordering','short_fill'] as const;
const json=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const rawAnswer=(state='ready',answer='B')=>`FINAL: ${answer}\nNSPI_RESULT_V1: ${JSON.stringify({v:1,kind:'single_choice',state,answer,reason:state==='ready'?'none':'ambiguous_question'})}`;
const retake='NSPI_RESULT_V1: {"v":1,"kind":"single_choice","state":"retake","answer":null,"reason":"cropped"}';
const noResult='NSPI_NO_RESULT_V1: {"v":1,"reason":"unsupported_scope"}';
function sse(id:string,raw=rawAnswer(),aux=false,tokens=10) {
  const parsed=composeScreenQuery(raw),usable=aux||parsed.charge;
  return [{type:'delta',text:raw},{type:'usage',input_tokens:tokens,output_tokens:5,questions_charged:aux?0:Number(usable),balance_questions:1000,
    capture_id:id,operation:aux?'explain':'solve',terminal_state:aux?'usable':parsed.terminalState,settlement_status:aux?'not_required':usable?'settled':'released',
    usable_result:usable,balance_version:'1',held_questions:0}].map(v=>'data: '+JSON.stringify(v)+'\n\n').join('')+'data: [DONE]\n\n';
}
async function corpusFixture(dir:string,count=4,explanations=1) {
  await writeFile(join(dir,'image.png'),pngBytes);
  const cases:ReadingCase[]=Array.from({length:count},(_,i)=>({id:'case-'+i,family_id:'family-'+i,kind:kinds[i%4]!,language:'zh',layout:'web',
    expectation:'answerable',risk:'none',accepted_answers:['B'],image_media_type:'image/png',images:[{file:'image.png',sha256:bytesSHA(pngBytes)}],
    scope:{target_count:1,question_image_index:0,rect:{x:i/(count+1),y:0,width:1/(count+1),height:1}}}));
  const split=json({schema_version:1,dataset_id:'synthetic-diagnostic',development_families:['development'],holdout_families:cases.map(c=>c.family_id)});
  await writeFile(join(dir,'split.json'),split);
  const manifest:ReadingManifest={schema_version:1,dataset_id:'synthetic-diagnostic',dataset_role:'diagnostic',scope_version:SCREEN_QUERY_VERSION,
    declarations:kinds.map(kind=>({profile:'reading_practice',kind,language:'zh'})),explanations_per_kind:explanations,
    family_split:{file:'split.json',sha256:bytesSHA(split)},authorization_review:{file:'review.json',sha256:'0'.repeat(64)},cases};
  const save=async()=>{
    const review=json({schema_version:1,reviewer:'test-reviewer',reviewed_at:at(),expires_at:future(),manifest_subject_sha256:readingManifestSubject(manifest),
      authorized_materials:true,external_model_processing:true,labels_reviewed:true,family_split_verified:true});
    manifest.authorization_review.sha256=bytesSHA(review);
    await writeFile(join(dir,'review.json'),review);await writeFile(join(dir,'manifest.json'),json(manifest));
  };
  await save();return {manifest,save,path:join(dir,'manifest.json')};
}
type Behavior={responses?:string[];statusAt?:number;status?:number;mimeAt?:number;breakAt?:number;tokenAt?:number;quota?:number;configuration?:string;negativeFails?:boolean;mutate?:()=>Promise<void>};
async function fixture(t:{after:(fn:()=>unknown)=>void},behavior:Behavior={},count=4,explanations=1) {
  const dir=await mkdtemp(join(tmpdir(),'nspi-reading-test-')),source=await corpusFixture(dir,count,explanations),requests:Array<{path:string;body:Record<string,unknown>}>=[];
  const send=(res:ServerResponse,body:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  const server=createServer(async(req,res)=>{
    if(req.method==='GET') {
      if(req.url==='/v1/account')return send(res,{balance_questions:behavior.quota??1000,held_questions:0});
      if(req.url==='/v1/client-config')return send(res,{revision:behavior.configuration??'test-r1',objective_result_v1:{protocol:'objective_v1'},screen_query:{support_revision:SCREEN_QUERY_VERSION,capabilities:['screen_query_v1'],enabled_profiles:['reading_practice']}});
      if(req.url==='/healthz')return send(res,{ok:true,provider:'mock',objective_provider:'mock'});
    }
    const buffers=[];for await(const chunk of req)buffers.push(chunk);const body=JSON.parse(Buffer.concat(buffers).toString());
    requests.push({path:req.url!,body});const index=requests.length-1;
    if(behavior.mutate)await behavior.mutate();
    if(index===behavior.breakAt){req.socket.destroy();return;}
    if(index===behavior.statusAt)return send(res,{error:{code:'feature_disabled'}},behavior.status??503);
    const aux=req.url!.endsWith('/explanation');
    if(aux&&body.final_answer==='')return send(res,{error:{code:behavior.negativeFails?'different':'binding_mismatch'}},409);
    res.writeHead(200,{'content-type':index===behavior.mimeAt?'application/json':'text/event-stream'});
    res.end(sse(String(aux?body.explanation_id:body.capture_id),aux?'The supplied answer follows from the selected option.':behavior.responses?.[requests.filter(r=>r.path==='/v1/captures').length-1]??rawAnswer(),aux,index===behavior.tokenAt?1001:10));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
  const base='http://127.0.0.1:'+address.port,evidence=json({synthetic:true,candidate:'test-only'});
  const candidate:ReadingCandidate={schema_version:1,base_url:base,model:'test-model',commit:'1'.repeat(40),app_version:'2.12',scope_version:SCREEN_QUERY_VERSION,
    config_revision:'test-r1',isolated:true,verified_by:'test-operator',verified_at:at(),expires_at:future(),verification_sha256:bytesSHA(evidence)};
  const bound:EvaluationCallBound={schema_version:1,model:candidate.model,base_url:base,billing_currency:'CNY',input_micros_per_million:1_000_000,
    output_micros_per_million:1_000_000,input_token_upper:1000,output_token_upper:1000,cny_micros_per_currency_unit:1_000_000,
    pricing_source:'https://example.invalid/test-only',currency_evidence:'synthetic',bounds_evidence:'synthetic',verified_at:at(),expires_at:future()};
  const budget=new EvaluationBudget(join(dir,'budget.sqlite3'),{schema_version:1,campaign_id:'test-only',currency:'CNY',limit_micros:100_000_000},bound,candidate.model,base);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));budget.close();await rm(dir,{recursive:true,force:true});});
  const output=join(dir,'run');
  const run=async()=>runReadingEvaluation({corpus:await loadReadingCorpus(source.path,'executor'),candidate,budget,executor:'executor',deviceToken:'synthetic-test-token',outputDir:output,
    candidateBytes:json(candidate),candidateEvidenceBytes:evidence});
  return {dir,source,requests,budget,bound,candidate,evidence,output,run};
}
async function reviewFiles(dir:string,archive:Awaited<ReturnType<typeof loadReadingArchive>>) {
  const answer={schema_version:1,reviewer:'independent-reviewer',reviewed_at:at(),subject_sha256:archive.completion.review_subject_sha256,
    labels_reviewed:true,results_reviewed:true,complete_run:archive.completion.complete,no_selection_reruns:true,authorized_materials:true,family_split_verified:true};
  const explanation={schema_version:1,reviewer:'independent-reviewer',reviewed_at:at(),subject_sha256:archive.explanation_subject_sha256,results_reviewed:true,
    cases:archive.explanations.map(e=>({capture_id:e.capture_id,response_sha256:e.response_sha256,correct:e.usable,consistent:true,no_unrelated_inference:true,material_leak:false,silent_answer_rewrite:false,severe_contradiction:false}))};
  const answerPath=join(dir,'answer-review.json'),explanationPath=join(dir,'explanation-review.json');
  await writeFile(answerPath,json(answer));await writeFile(explanationPath,json(explanation));return {answer,explanation,answerPath,explanationPath};
}

test('reading corpus validates image bytes, authorization, family separation and immutable target identities',async t=>{
  const f=await fixture(t);assert.equal((await loadReadingCorpus(f.source.path,'executor')).manifest.cases.length,4);
  await assert.rejects(loadReadingCorpus(f.source.path,'TEST-REVIEWER'),/independent/);
  const duplicated=structuredClone(f.source.manifest);duplicated.cases[1]!.scope=duplicated.cases[0]!.scope;
  assert.throws(()=>parseReadingManifest(duplicated),/Duplicate corpus target/);
  assert.throws(()=>parseReadingManifest({...f.source.manifest,dataset_role:'holdout'}),/400/);
  assert.throws(()=>parseReadingManifest({...f.source.manifest,unknown:true}));
  const traversal=structuredClone(f.source.manifest);traversal.cases[0]!.images[0]!.file='../image.png';assert.throws(()=>parseReadingManifest(traversal),/inside/);
  await writeFile(join(f.dir,'image.png'),Buffer.from('invalid'));await assert.rejects(loadReadingCorpus(f.source.path,'executor'),/digest/);
});

test('reading corpus rejects external processing denial, expiry, split overlap and symlink material',async t=>{
  const f=await fixture(t);const reviewPath=join(f.dir,'review.json'),original=JSON.parse(await readFile(reviewPath,'utf8'));
  for(const review of [{...original,external_model_processing:false},{...original,expires_at:new Date(Date.now()-1).toISOString()}]) {
    const bytes=json(review);f.source.manifest.authorization_review.sha256=bytesSHA(bytes);
    await writeFile(reviewPath,bytes);await writeFile(f.source.path,json(f.source.manifest));await assert.rejects(loadReadingCorpus(f.source.path,'executor'),/independent/);
  }
  const split=json({schema_version:1,dataset_id:f.source.manifest.dataset_id,development_families:['family-0'],holdout_families:f.source.manifest.cases.map(c=>c.family_id)});
  f.source.manifest.family_split.sha256=bytesSHA(split);await writeFile(join(f.dir,'split.json'),split);await f.source.save();await assert.rejects(loadReadingCorpus(f.source.path,'executor'),/overlaps/);
  const other=await corpusFixture(f.dir);await writeFile(join(f.dir,'other.png'),pngBytes);await rm(join(f.dir,'image.png'));await symlink(join(f.dir,'other.png'),join(f.dir,'image.png'));
  await assert.rejects(loadReadingCorpus(other.path,'executor'),/unavailable/);
});

test('holdout declarations require independently counted kinds, cells, layouts and risk cases',async t=>{
  const f=await fixture(t,{},420,20),m=f.source.manifest;m.dataset_role='holdout';
  for(const [i,item] of m.cases.entries()) {
    item.layout=(['web','pdf','practice_ui','multi_page'] as const)[i%4]!;
    if(i<4) {item.expectation=(['retake','out_of_scope','multiple_targets','retake'] as const)[i]!;item.accepted_answers=[];item.risk=(['missing_context','cropped','unreadable','ambiguous'] as const)[i]!;}
  }
  assert.equal(parseReadingManifest(m).cases.length,420);
  assert.throws(()=>parseReadingManifest({...m,declarations:[...m.declarations,{profile:'reading_practice',kind:'single_choice',language:'en'}]}),/50/);
  assert.throws(()=>parseReadingManifest({...m,explanations_per_kind:19}),/80/);
  assert.throws(()=>parseReadingManifest({...m,cases:m.cases.map(c=>({...c,layout:'web'}))}),/coverage/);
});

test('reading SSE requires complete, bound, correctly ordered settlement and preserves protocol scoring',async t=>{
  const f=await fixture(t),id=randomUUID(),body=sse(id),corpus=await loadReadingCorpus(f.source.path,'executor');
  assert.equal(scoreReadingCase(corpus,corpus.manifest.cases[0]!,parseReadingStream('\uFEFF'+body.replaceAll('\n','\r\n'),id),12).answer_correct,true);
  for(const bad of [body.slice(0,-1),body.slice(0,-2),body.replace('"input_tokens":10','"input_tokens":"10"'),body.replace(id,randomUUID()),
    body+'data: [DONE]\n\n',body.replace('"questions_charged":1','"questions_charged":0'),body.replace('"balance_version":"1"','"balance_version":"-1"'),
    body.replace('data: [DONE]\n\n','')])assert.throws(()=>parseReadingStream(bad,id));
  assert.equal(scoreReadingCase(corpus,corpus.manifest.cases[0]!,parseReadingStream(sse(id,retake),id),10).state,'retake');
  assert.equal(scoreReadingCase(corpus,corpus.manifest.cases[0]!,parseReadingStream(sse(id,noResult),id),10).parser_path,'screen_no_result');
  assert.equal(scoreReadingCase(corpus,corpus.manifest.cases[0]!,null,10).state,'failed');
});

test('reading runner freezes full order, invokes explanation immediately, and rebuilds identical scores offline',async t=>{
  const f=await fixture(t);const completion=await f.run();assert.equal(completion.complete,true);assert.equal(completion.explanation_calls,4);
  assert.equal(f.requests.length,8);
  for(let i=0;i<8;i+=2) {
    const parent=f.requests[i]!,aux=f.requests[i+1]!;assert.equal(parent.path,'/v1/captures');assert.equal(aux.path,`/v1/captures/${parent.body.capture_id}/explanation`);
    assert.deepEqual(aux.body.images_base64,[pngBytes.toString('base64')]);assert.equal(aux.body.final_answer,'B');
  }
  const archive=await loadReadingArchive(f.output);assert.ok(archive.draft.cases.every(c=>c.answer_correct));assert.equal(archive.explanations.length,4);
  assert.equal(archive.cost_bounds[0]!.reserved_cny_micros,8000);assert.equal(archive.cost_bounds[1]!.reserved_cny_micros,8000);
  assert.equal((await stat(join(f.output,'quality-draft.json'))).mode&0o777,0o600);
  assert.equal((await stat(f.output)).mode&0o777,0o700);
  const reviews=await reviewFiles(f.dir,archive),prepared=await prepareReadingQuality(f.output,reviews.answerPath,reviews.explanationPath);
  assert.equal(prepared.provenance.explanations.assessment,'insufficient_evidence');assert.equal(prepared.provenance.release_ready,false);
  assert.equal(prepared.report.assessment,'insufficient_evidence');
  const reserved=f.budget.remainingMicros();await assert.rejects(f.run(),/EEXIST/);assert.equal(f.budget.remainingMicros(),reserved);
});

test('ordinary transport and invalid MIME failures remain in a complete run without retries',async t=>{
  const f=await fixture(t,{breakAt:0,mimeAt:1},4,0);assert.equal((await f.run()).complete,true);
  const archive=await loadReadingArchive(f.output);assert.equal(archive.draft.cases.length,4);assert.deepEqual(archive.draft.cases.map(c=>c.state),['failed','failed','ready','ready']);
  assert.equal(f.requests.length,4);assert.equal(f.budget.remainingMicros(),100_000_000-8000);
});

for(const [name,behavior] of Object.entries({quota:{quota:1},configuration:{configuration:'changed'}})) {
  test(`reading admission refuses ${name} before creating output or reserving model cost`,async t=>{
    const f=await fixture(t,behavior);await assert.rejects(f.run());assert.equal(f.requests.length,0);assert.equal(f.budget.remainingMicros(),100_000_000);await assert.rejects(stat(f.output));
  });
}
test('candidate rejection halts with a reviewable partial run and unchanged unattempted denominator',async t=>{
  const f=await fixture(t,{statusAt:1},4,0),completion=await f.run();assert.equal(completion.complete,false);assert.equal(completion.answer_cases,2);
  const archive=await loadReadingArchive(f.output),reviews=await reviewFiles(f.dir,archive),prepared=await prepareReadingQuality(f.output,reviews.answerPath);
  assert.equal(prepared.report.execution.missing_cases,2);assert.equal(prepared.submission.review.complete_run,false);
  reviews.answer.complete_run=true;await writeFile(reviews.answerPath,json(reviews.answer));await assert.rejects(prepareReadingQuality(f.output,reviews.answerPath),/partial/);
});
test('token upper bound violation keeps the received result and stops the shared campaign',async t=>{
  const f=await fixture(t,{tokenAt:0}),completion=await f.run();assert.equal(completion.complete,false);assert.equal(f.requests.length,1);assert.equal(f.budget.remainingMicros(),0);
  const archive=await loadReadingArchive(f.output);assert.equal(archive.draft.cases[0]!.input_tokens,1001);
});
test('retake and no-result parent explanation entry rejections are frozen and checked separately',async t=>{
  const f=await fixture(t,{responses:[retake,noResult,rawAnswer(),rawAnswer()]},4,0);
  const completion=await f.run();assert.equal(completion.complete,true);assert.equal(completion.rejection_checks,2);
  const archive=await loadReadingArchive(f.output);assert.deepEqual(archive.rejection_checks.map(r=>[r.parent_state,r.rejected]),[['retake',true],['no_result',true]]);
});
test('unrecognized explanation rejection cannot pass the run',async t=>{
  const f=await fixture(t,{responses:[retake],negativeFails:true},4,0);assert.equal((await f.run()).halt_reason,'explanation_rejection_contract_failed');assert.equal(f.requests.length,2);
  assert.equal((await loadReadingArchive(f.output)).rejection_checks[0]!.rejected,false);
});
test('source bytes changed after preflight stop the next dispatch',async t=>{
  let changed=false;const behavior:Behavior={};const f=await fixture(t,behavior,4,0);
  behavior.mutate=async()=>{if(!changed){changed=true;await writeFile(join(f.dir,'image.png'),Buffer.from('changed'));}};
  const completion=await f.run();assert.equal(completion.complete,false);assert.equal(f.requests.length,1);assert.equal(completion.halt_reason,'input_or_artifact_integrity_failed');
  assert.equal((await loadReadingArchive(f.output)).draft.cases.length,1);
});
test('offline rebuild rejects raw tampering, fabricated scores, orphan dispatches and dependent reviews',async t=>{
  const f=await fixture(t);await f.run();const archive=await loadReadingArchive(f.output),reviews=await reviewFiles(f.dir,archive);
  for(const answer of [{...reviews.answer,reviewer:'EXECUTOR'},{...reviews.answer,subject_sha256:'0'.repeat(64)}]) {
    await writeFile(reviews.answerPath,json(answer));await assert.rejects(prepareReadingQuality(f.output,reviews.answerPath));
  }
  const index=JSON.parse(await readFile(join(f.output,'results.json'),'utf8')),rawPath=join(f.output,index[0].file),original=await readFile(rawPath);
  await writeFile(rawPath,Buffer.concat([original,Buffer.from(' ')]));await assert.rejects(loadReadingArchive(f.output),/digest/);await writeFile(rawPath,original);
  const draftPath=join(f.output,'quality-draft.json'),draftOriginal=await readFile(draftPath),draft=JSON.parse(draftOriginal.toString());draft.cases[0].answer_correct=false;
  await writeFile(draftPath,json(draft));await assert.rejects(loadReadingArchive(f.output));await writeFile(draftPath,draftOriginal);
  await writeFile(join(f.output,'responses',randomUUID()+'.dispatch.json'),'{}');await assert.rejects(loadReadingArchive(f.output));
});
test('an edited archive cannot omit frozen explanation selections even with recomputed summary hashes',async t=>{
  const f=await fixture(t);await f.run();
  const indexPath=join(f.output,'results.json'),index=JSON.parse(await readFile(indexPath,'utf8')),removed=index.splice(1,1)[0];
  await rm(join(f.output,removed.file));await rm(join(f.output,removed.file.replace('.json','.dispatch.json')));
  const indexBytes=json(index);await writeFile(indexPath,indexBytes);
  const draftPath=join(f.output,'quality-draft.json'),draft=JSON.parse(await readFile(draftPath,'utf8'));draft.run.results_sha256=bytesSHA(indexBytes);
  const draftBytes=json(draft);await writeFile(draftPath,draftBytes);
  const completionPath=join(f.output,'completion.json'),completion=JSON.parse(await readFile(completionPath,'utf8'));
  completion.results_sha256=bytesSHA(indexBytes);completion.draft_sha256=bytesSHA(draftBytes);completion.review_subject_sha256=qualityReviewSubject(draft);completion.explanation_calls--;
  await writeFile(completionPath,json(completion));await assert.rejects(loadReadingArchive(f.output),/selection was skipped/);
});
test('explanation review binds every raw result and preserves serious contradictions as failed gates',async t=>{
  const f=await fixture(t);await f.run();const archive=await loadReadingArchive(f.output),reviews=await reviewFiles(f.dir,archive);
  reviews.explanation.cases[0]!.severe_contradiction=true;await writeFile(reviews.explanationPath,json(reviews.explanation));
  assert.equal((await prepareReadingQuality(f.output,reviews.answerPath,reviews.explanationPath)).provenance.explanations.assessment,'thresholds_failed');
  reviews.explanation.cases.pop();await writeFile(reviews.explanationPath,json(reviews.explanation));await assert.rejects(prepareReadingQuality(f.output,reviews.answerPath,reviews.explanationPath),/incomplete/);
});
test('reading CLIs do not dispatch without explicit input and inspect archives without credentials',async t=>{
  const f=await fixture(t);await f.run();const exec=promisify(execFile),runScript=join(import.meta.dirname,'../../scripts/run-reading-eval.mjs'),prepareScript=join(import.meta.dirname,'../../scripts/prepare-reading-quality.mjs');
  await assert.rejects(exec(process.execPath,[runScript],{env:{PATH:process.env.PATH}}));
  const before=f.requests.length,result=await exec(process.execPath,[prepareScript,'--run',f.output],{env:{PATH:process.env.PATH}});
  assert.equal(JSON.parse(result.stdout).answer_cases,4);assert.equal(f.requests.length,before);
  const reviews=await reviewFiles(f.dir,await loadReadingArchive(f.output));await exec(process.execPath,[prepareScript,'--run',f.output,'--review',reviews.answerPath,'--out',join(f.dir,'prepared')]);
  assert.equal((JSON.parse(await readFile(join(f.dir,'prepared','submission.json'),'utf8'))).cases.length,4);
});
test('offline preflight accepts an official device credential without requiring a direct provider key',async t=>{
  const f=await fixture(t);await writeFile(join(f.dir,'candidate.json'),json(f.candidate));await writeFile(join(f.dir,'evidence.bin'),f.evidence);await writeFile(join(f.dir,'bound.json'),json(f.bound));
  const result=await promisify(execFile)(process.execPath,[join(import.meta.dirname,'../../scripts/evaluation-preflight.mjs')],{env:{PATH:process.env.PATH,
    NSPI_READING_EVAL_MANIFEST:f.source.path,NSPI_EVAL_EXECUTOR:'executor',NSPI_EVAL_DEVICE_TOKEN:'synthetic-test-token',
    NSPI_EVAL_CANDIDATE_ATTESTATION:join(f.dir,'candidate.json'),NSPI_EVAL_CANDIDATE_EVIDENCE:join(f.dir,'evidence.bin'),NSPI_EVAL_COST_BOUND:join(f.dir,'bound.json')}}).catch(error=>error);
  assert.equal(result.code,2);const report=JSON.parse(result.stdout);assert.equal(report.reading_corpus.status,'validated_review_claim');
  assert.equal(report.candidate_evidence.status,'validated_operator_claim');assert.equal(report.cost_bound.status,'valid');assert.equal(report.paid_model_calls,0);
  assert.ok(!report.blockers.includes('isolated_evaluation_device_credential_missing'));assert.ok(!report.blockers.includes('no_model_key_in_process_environment'));assert.equal(f.requests.length,0);
});

for(const kind of ['memory','sqlite'] as const) {
  test(`${kind}: runner uses real capture, HMAC explanation binding, quota settlement and entry refusal routes`,async t=>{
    const f=await fixture(t,{},5,1),app=Fastify({logger:false}),store=kind==='memory'?new MemoryStore():new SqliteStore(':memory:');
    let solves=0,explanations=0;const outputs=[rawAnswer(),rawAnswer('review'),'FINAL: B',retake,noResult];
    const provider={name:'mock',async stream(request:{system:string;task:string},delta:(text:string)=>void) {
      if(request.system.includes('exactly consistent')) {explanations++;assert.equal(JSON.parse(request.task).final_answer,'B');delta(JSON.stringify({consistent:true,explanation:'依据图中选项，答案为 B。'}));}
      else {delta(outputs[solves++]!);}return {inputTokens:10,outputTokens:5};
    }};
    const settings={...config,provider:'mock' as const,objectiveProvider:'mock' as const,model:'test-model',objectiveModel:'test-model',
      requestHmacKeysJSON:JSON.stringify({test:Buffer.alloc(32,1).toString('base64')}),requestHmacKeyVersion:'test',dbPath:':memory:',requireDurableStorage:false,
      screenQueryEnabled:true,explanationEnabled:true,enabledSupportProfiles:'reading_practice',deviceRegPerHour:0,
      objectiveResultV1Bps:10_000,objectiveResultExperimentSalt:'test-only',clientConfigRevision:'test-r1',attemptBudgetUpperMicros:100,modelDailyBudgetMicros:10_000};
    registerRoutes(app,{config:settings,store,storeKind:kind,provider,objectiveProvider:provider,providerDegraded:null,objectiveProviderDegraded:null,payment:new StubPaymentProvider()});
    t.after(async()=>{await app.close();await store.close();});
    const base=await app.listen({host:'127.0.0.1',port:0}),{token}=await store.registerDevice({platform:'macos',appVersion:'2.12',trialQuestions:30});
    const candidate={...f.candidate,base_url:base},evidence=json({synthetic:true,candidate:'test-only'});
    const bound:EvaluationCallBound={schema_version:1,model:'test-model',base_url:base,billing_currency:'CNY',input_micros_per_million:1_000_000,output_micros_per_million:1_000_000,
      input_token_upper:1000,output_token_upper:1000,cny_micros_per_currency_unit:1_000_000,pricing_source:'https://example.invalid/test-only',currency_evidence:'synthetic',bounds_evidence:'synthetic',verified_at:at(),expires_at:future()};
    const budget=new EvaluationBudget(join(f.dir,'real-routes.sqlite3'),{schema_version:1,campaign_id:'test-only-real-routes',currency:'CNY',limit_micros:100_000_000},bound,candidate.model,base);t.after(()=>budget.close());
    const completion=await runReadingEvaluation({corpus:await loadReadingCorpus(f.source.path,'executor'),candidate,budget,executor:'executor',deviceToken:token,outputDir:f.output,candidateBytes:json(candidate),candidateEvidenceBytes:evidence});
    assert.equal(completion.complete,true);assert.equal(solves,5);assert.equal(explanations,3);assert.equal(completion.rejection_checks,2);
    assert.equal((await store.billing.attempts(token)).length,8);assert.equal((await store.billing.quota(token))?.balanceQuestions,27);assert.equal((await store.billing.quota(token))?.heldQuestions,0);
    const archive=await loadReadingArchive(f.output);assert.deepEqual(archive.draft.cases.map(c=>c.state),['ready','review','review','retake','no_result']);
    assert.equal(archive.draft.cases[2]!.parser_path,'legacy_fallback');assert.equal(archive.rejection_checks.every(c=>c.rejected),true);
  });
}
