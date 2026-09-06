import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {imageDigests,SCREEN_QUERY_VERSION,validateScope} from '../../server/src/screen-query.ts';
import {composeScreenQuery} from '../../server/src/screen-query.ts';
import {objectiveEvalAnswerHit} from '../../server/src/objective-eval-scoring.ts';
import {qualityDigest,type QualityCase,type QualityCombination,type QualityRun} from '../../server/src/quality.ts';

export class ReadingEvidenceError extends Error {
  constructor(message:string) {super(message);this.name='ReadingEvidenceError';}
}
const invalid=(message='Invalid reading evaluation evidence'):never=>{throw new ReadingEvidenceError(message);};
export const bytesSHA=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const kinds=['single_choice','multiple_choice','ordering','short_fill'] as const;
function object(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.slice().sort().join(','))return invalid();
  return value as Record<string,unknown>;
}
function choice<T extends string>(value:unknown,allowed:readonly T[]):T {
  if(typeof value!=='string'||!allowed.includes(value as T))return invalid();return value as T;
}
function id(value:unknown):string {if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value))return invalid();return value;}
function sha(value:unknown):string {if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))return invalid();return value;}
function integer(value:unknown,max:number):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)return invalid();return value;}
function timestamp(value:unknown):string {
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)return invalid();return value;
}
export interface EvidenceFile {file:string;sha256:string}
function reference(value:unknown):EvidenceFile {
  const raw=object(value,['file','sha256']);
  if(typeof raw.file!=='string'||!raw.file||raw.file.length>512||isAbsolute(raw.file)||raw.file.includes('\\')||
    raw.file.split('/').some(part=>!part||part==='.'||part==='..'))return invalid('Evidence paths must stay inside the corpus directory');
  return {file:raw.file,sha256:sha(raw.sha256)};
}
export interface ReadingCase {
  id:string;family_id:string;kind:QualityCase['kind'];language:QualityCase['language'];layout:QualityCase['layout'];
  expectation:QualityCase['expectation'];risk:QualityCase['risk'];accepted_answers:string[];
  image_media_type:'image/png'|'image/jpeg';images:EvidenceFile[];
  scope:ReturnType<typeof validateScope>;
}
export interface ReadingManifest {
  schema_version:1;dataset_id:string;dataset_role:'holdout'|'diagnostic';scope_version:string;
  declarations:QualityCombination[];explanations_per_kind:number;
  family_split:EvidenceFile;authorization_review:EvidenceFile;cases:ReadingCase[];
}
export function readingManifestSubject(manifest:ReadingManifest):string {
  const {authorization_review:_,...subject}=manifest;return qualityDigest(subject);
}
export function parseReadingManifest(value:unknown):ReadingManifest {
  const raw=object(value,['schema_version','dataset_id','dataset_role','scope_version','declarations','explanations_per_kind','family_split','authorization_review','cases']);
  if(raw.schema_version!==1||raw.scope_version!==SCREEN_QUERY_VERSION||!Array.isArray(raw.cases)||!raw.cases.length||raw.cases.length>5000||
    !Array.isArray(raw.declarations)||raw.declarations.length>12)return invalid();
  const cases=raw.cases.map(value=>{
    const c=object(value,['id','family_id','kind','language','layout','expectation','risk','accepted_answers','image_media_type','images','scope']);
    if(!Array.isArray(c.images)||!c.images.length||c.images.length>4||!Array.isArray(c.accepted_answers)||c.accepted_answers.length>16)return invalid();
    const expectation=choice(c.expectation,['answerable','retake','out_of_scope','multiple_targets','unlabelled']);
    const answers=c.accepted_answers.map(answer=>{
      if(typeof answer!=='string'||!answer.trim()||[...answer].length>512)return invalid();return answer;
    });
    if((expectation==='answerable')!==(answers.length>0)||new Set(answers).size!==answers.length)return invalid();
    let scope:ReturnType<typeof validateScope>;
    try {scope=validateScope(c.scope,c.images.length);}catch{return invalid('Invalid corpus target scope');}
    return {id:id(c.id),family_id:id(c.family_id),kind:choice(c.kind,[...kinds,'other']),language:choice(c.language,['zh','ja','en']),
      layout:choice(c.layout,['web','pdf','practice_ui','multi_page','single_image','unknown']),expectation,
      risk:choice(c.risk,['none','missing_context','cropped','unreadable','ambiguous']),accepted_answers:answers,
      image_media_type:choice(c.image_media_type,['image/png','image/jpeg']),images:c.images.map(reference),scope};
  });
  if(new Set(cases.map(c=>c.id)).size!==cases.length)return invalid('Duplicate corpus case ID');
  // Identical materials and scope are one target, not independent holdout samples.
  const targets=cases.map(c=>qualityDigest({images:c.images.map(i=>i.sha256),scope:c.scope}));
  if(new Set(targets).size!==targets.length)return invalid('Duplicate corpus target');
  const declarations=raw.declarations.map(value=>{
    const d=object(value,['profile','kind','language']);
    return {profile:choice(d.profile,['reading_practice']),kind:choice(d.kind,kinds),language:choice(d.language,['zh','ja','en'])};
  });
  if(new Set(declarations.map(qualityDigest)).size!==declarations.length)return invalid('Duplicate support declaration');
  const manifest:ReadingManifest={schema_version:1,dataset_id:id(raw.dataset_id),dataset_role:choice(raw.dataset_role,['holdout','diagnostic']),
    scope_version:SCREEN_QUERY_VERSION,declarations,explanations_per_kind:integer(raw.explanations_per_kind,100),
    family_split:reference(raw.family_split),authorization_review:reference(raw.authorization_review),cases};
  if(manifest.dataset_role==='holdout') {
    const declared=cases.filter(c=>c.expectation!=='unlabelled'&&declarations.some(d=>d.kind===c.kind&&d.language===c.language));
    if(declared.length<400||kinds.some(kind=>declared.filter(c=>c.kind===kind).length<100)||!declarations.length||
      declarations.some(d=>declared.filter(c=>c.kind===d.kind&&c.language===d.language).length<50)||manifest.explanations_per_kind<20)
      return invalid('Holdout requires 400 labelled cases, 100 per kind, 50 per declaration and an 80-explanation plan');
    if(['web','pdf','practice_ui','multi_page'].some(layout=>!cases.some(c=>c.layout===layout))||
      ['retake','out_of_scope','multiple_targets'].some(expectation=>!cases.some(c=>c.expectation===expectation))||
      ['missing_context','cropped','unreadable','ambiguous'].some(risk=>!cases.some(c=>c.risk===risk)))
      return invalid('Holdout layout and risk coverage is incomplete');
  }
  return manifest;
}

/** Bounded descriptor read; source paths cannot escape through an absolute path or symlink. */
export async function readEvidenceFile(path:string,limit:number):Promise<Buffer> {
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>invalid('Evidence file unavailable'));
  try {
    const info=await handle.stat();if(!info.isFile()||info.size>limit)return invalid('Evidence file type or size invalid');
    const chunks:Buffer[]=[];let length=0;
    while(true) {
      const chunk=Buffer.alloc(Math.min(65_536,limit-length+1));
      const result=await handle.read(chunk,0,chunk.length,null);if(!result.bytesRead)break;
      length+=result.bytesRead;if(length>limit)return invalid('Evidence file exceeded its read limit');
      chunks.push(chunk.subarray(0,result.bytesRead));
    }
    return Buffer.concat(chunks);
  } finally {await handle.close();}
}
export async function corpusFile(root:string,ref:EvidenceFile,limit:number):Promise<Buffer> {
  const path=resolve(root,ref.file),parent=await realpath(dirname(path)).catch(()=>invalid('Evidence directory unavailable'));
  const rel=relative(root,parent);if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))return invalid('Evidence path escaped corpus');
  const data=await readEvidenceFile(resolve(parent,path.slice(dirname(path).length+1)),limit);
  if(bytesSHA(data)!==ref.sha256)return invalid('Evidence file digest mismatch');return data;
}
export function evidenceJSON(data:Buffer):unknown {try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{return invalid('Evidence JSON is malformed');}}
export interface LoadedReadingCorpus {
  root:string;manifest:ReadingManifest;manifestBytes:Buffer;manifestSHA:string;
  review:{reviewer:string;reviewed_at:string;expires_at:string};
}
export async function loadReadingCorpus(path:string,executor:string,now=Date.now()):Promise<LoadedReadingCorpus> {
  const root=await realpath(dirname(resolve(path))),manifestBytes=await readEvidenceFile(resolve(path),8*1024*1024);
  const manifest=parseReadingManifest(evidenceJSON(manifestBytes));
  const review=validateCorpusReview(manifest,await corpusFile(root,manifest.family_split,1024*1024),
    await corpusFile(root,manifest.authorization_review,1024*1024),executor,now);
  const corpus={root,manifest,manifestBytes,manifestSHA:bytesSHA(manifestBytes),review};
  for(const item of manifest.cases)await readingImages(corpus,item,now);
  return corpus;
}
export function validateCorpusReview(manifest:ReadingManifest,splitBytes:Buffer,reviewBytes:Buffer,executor:string,now:number):LoadedReadingCorpus['review'] {
  if(bytesSHA(splitBytes)!==manifest.family_split.sha256||bytesSHA(reviewBytes)!==manifest.authorization_review.sha256)return invalid('Corpus metadata digest mismatch');
  const split=object(evidenceJSON(splitBytes),
    ['schema_version','dataset_id','development_families','holdout_families']);
  if(split.schema_version!==1||split.dataset_id!==manifest.dataset_id||!Array.isArray(split.development_families)||!Array.isArray(split.holdout_families))return invalid();
  const development=split.development_families.map(id),holdout=split.holdout_families.map(id),families=new Set(manifest.cases.map(c=>c.family_id));
  if(new Set(development).size!==development.length||new Set(holdout).size!==holdout.length||development.some(f=>holdout.includes(f))||
    holdout.length!==families.size||holdout.some(f=>!families.has(f)))return invalid('Family split overlaps or differs from the frozen corpus');
  const review=object(evidenceJSON(reviewBytes),
    ['schema_version','reviewer','reviewed_at','expires_at','manifest_subject_sha256','authorized_materials','external_model_processing','labels_reviewed','family_split_verified']);
  const reviewer=id(review.reviewer),reviewedAt=timestamp(review.reviewed_at),expiresAt=timestamp(review.expires_at);
  if(review.schema_version!==1||reviewer.toLowerCase()===executor.toLowerCase()||Date.parse(reviewedAt)>now||Date.parse(expiresAt)<=now||
    review.manifest_subject_sha256!==readingManifestSubject(manifest)||
    ['authorized_materials','external_model_processing','labels_reviewed','family_split_verified'].some(key=>review[key]!==true))
    return invalid('Corpus requires current, independent authorization/label/family review including external model processing');
  return {reviewer,reviewed_at:reviewedAt,expires_at:expiresAt};
}
export async function readingImages(corpus:LoadedReadingCorpus,item:ReadingCase,now=Date.now()):Promise<string[]> {
  if(Date.parse(corpus.review.expires_at)<=now)return invalid('Corpus authorization expired');
  const images=[];
  for(const ref of item.images)images.push({base64:(await corpusFile(corpus.root,ref,6*1024*1024)).toString('base64'),mediaType:item.image_media_type});
  const digests=await imageDigests(images);
  if(digests.some((digest,index)=>digest!==item.images[index]!.sha256))return invalid('Decoded corpus image digest changed');
  return images.map(image=>image.base64);
}

export interface ReadingReceipt {
  input_tokens:number;output_tokens:number;questions_charged:number;balance_questions:number;
  capture_id:string;operation:string;terminal_state:string;settlement_status:string;usable_result:boolean;
  balance_version:string;held_questions:number;
}
export interface ReadingStream {raw:string;receipt:ReadingReceipt;error:string|null}
export function parseReadingStream(body:string,captureID:string,operation:'solve'|'explain'|'recover'='solve'):ReadingStream {
  if(Buffer.byteLength(body)>2*1024*1024)return invalid('SSE response limit');
  let raw='',receipt:ReadingReceipt|null=null,error:string|null=null,done=false,eventBytes=0;const data:string[]=[];
  const dispatch=()=>{
    if(!data.length)return;const payload=data.join('\n');data.length=0;eventBytes=0;
    if(done)return invalid('Data after terminal SSE event');
    if(payload==='[DONE]'){if(!receipt)return invalid('SSE ended before settlement');done=true;return;}
    let value:Record<string,unknown>;try{value=JSON.parse(payload);}catch{return invalid('Malformed SSE event');}
    if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
    if(value.type==='delta') {
      if(receipt||error||typeof value.text!=='string')return invalid('Invalid SSE delta order');raw+=value.text;
      if(Buffer.byteLength(raw)>64*1024)return invalid('SSE content limit');
    } else if(value.type==='error') {
      if(receipt||error||!value.error||typeof value.error!=='object'||Array.isArray(value.error))return invalid('Invalid SSE error');
      const detail=value.error as Record<string,unknown>;if(typeof detail.code!=='string'||typeof detail.message!=='string')return invalid();error=detail.code;
    } else if(value.type==='usage') {
      if(receipt||value.capture_id!==captureID||value.operation!==operation||typeof value.usable_result!=='boolean'||
        typeof value.balance_version!=='string'||!/^\d{1,40}$/.test(value.balance_version))return invalid('Unbound SSE settlement');
      for(const key of ['input_tokens','output_tokens','balance_questions','held_questions'])integer(value[key],Number.MAX_SAFE_INTEGER);
      const charge=integer(value.questions_charged,1),state=value.terminal_state,settlement=value.settlement_status;
      if(operation!=='solve'&&charge!==0)return invalid();
      if(charge===1) {if(state!=='usable'||settlement!=='settled'||!value.usable_result||!raw.trim()||error)return invalid();}
      else if(operation==='solve') {if(settlement!=='released'||value.usable_result||!['retake','no_result','failed','canceled'].includes(String(state)))return invalid();}
      else if(settlement!=='not_required'||!['usable','failed','canceled'].includes(String(state))||value.usable_result!==(state==='usable')||
        value.usable_result&&(!raw.trim()||error))return invalid();
      receipt=value as unknown as ReadingReceipt;
    } else return invalid('Unknown SSE event');
  };
  const text=body.startsWith('\uFEFF')?body.slice(1):body;
  const lines=text.split(/\r\n|\r|\n/u);if(lines.at(-1)==='')lines.pop();
  for(const line of lines) {
    if(!line){dispatch();continue;}if(line.startsWith(':'))continue;
    const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon);if(field!=='data')continue;
    let value=colon<0?'':line.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);
    eventBytes+=Buffer.byteLength(value)+(data.length?1:0);
    if(eventBytes>512*1024)return invalid('SSE event limit');data.push(value);
  }
  if(!done||!receipt||data.length)return invalid('Incomplete SSE stream');
  return {raw,receipt,error};
}
export function scoreReadingCase(corpus:LoadedReadingCorpus,item:ReadingCase,stream:ReadingStream|null,requestMS:number|null):QualityCase {
  const parsed=stream?composeScreenQuery(stream.raw):null,usable=!!stream&&!!parsed?.charge&&stream.receipt.usable_result&&stream.receipt.questions_charged===1;
  const valid=!!stream&&parsed?.terminalState===stream.receipt.terminal_state&&Boolean(parsed.charge)===(stream.receipt.questions_charged===1);
  const path=valid?parsed?.objective.parserPath==='v1'?'v1':parsed?.objective.parserPath==='legacy_fallback'?'legacy_fallback':parsed?.terminalState==='no_result'?'screen_no_result':'none':'none';
  const hasAnswer=valid&&usable;
  return {case_sha256:qualityDigest({dataset:corpus.manifestSHA,case_id:item.id}),family_sha256:qualityDigest({dataset_id:corpus.manifest.dataset_id,family_id:item.family_id}),
    profile:'reading_practice',kind:item.kind,language:item.language,layout:item.layout,expectation:item.expectation,risk:item.risk,
    state:path==='none'?'failed':path==='screen_no_result'?'no_result':parsed!.objective.state!,parser_path:path,
    protocol_valid:path==='v1'||path==='screen_no_result',no_result_reason:path==='screen_no_result'?parsed!.reason as 'unsupported_scope'|'multiple_targets':null,
    has_answer:hasAnswer,answer_correct:hasAnswer&&item.expectation!=='unlabelled'?item.expectation==='answerable'&&objectiveEvalAnswerHit(parsed!.objective.finalAnswer,item.accepted_answers):null,
    request_ms:requestMS,input_tokens:stream&&stream.receipt.input_tokens>0?stream.receipt.input_tokens:null,
    output_tokens:stream&&stream.receipt.output_tokens>0?stream.receipt.output_tokens:null};
}
export interface ReadingDraft {schema_version:1;run:QualityRun;declarations:QualityCombination[];cases:QualityCase[]}
