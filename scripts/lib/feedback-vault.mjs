import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i,sha=/^[a-f0-9]{64}$/;
const reference=/^[A-Za-z0-9_.:-]{1,100}$/;
const digest=data=>createHash('sha256').update(data).digest('hex');
const repository=fs.realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
function check(value,message){if(!value)throw new Error(message);}
function object(value,keys,optional=[]){
  check(value&&typeof value==='object'&&!Array.isArray(value),'Expected a record');
  check(Object.keys(value).every(k=>keys.includes(k)||optional.includes(k))&&keys.every(k=>Object.hasOwn(value,k)),'Unexpected or missing feedback fields');
}
function date(value){check(typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value)),'Invalid feedback time');return Date.parse(value);}
function parseJSON(bytes){try{return JSON.parse(bytes);}catch{throw new Error('Invalid feedback JSON; contents were omitted');}}
function readBounded(file,limit){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(fd);check(stat.isFile()&&stat.size<=limit,'Feedback file is not a bounded regular file');
    const buffer=Buffer.alloc(limit+1);let length=0;
    while(length<buffer.length){const count=fs.readSync(fd,buffer,length,buffer.length-length,null);if(count===0)break;length+=count;}
    check(length<=limit,'Feedback file changed size');return buffer.subarray(0,length);
  }finally{fs.closeSync(fd);}
}
function privateDirectory(directory){
  const stat=fs.lstatSync(directory);
  check(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.uid===process.getuid(),'Feedback vault requires an owned private directory (0700)');
}
function atomicJSON(file,value){
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
  finally{fs.rmSync(temporary,{force:true});}
}
export function validateFeedbackManifest(m,now=Date.now()){
  object(m,['submission_id','authorization_version','authorization','purpose','retention','exported_at','capture_id','session_id','answer','assets'],['standard_answer']);
  for(const key of ['submission_id','capture_id','session_id'])check(typeof m[key]==='string'&&uuid.test(m[key]),'Invalid feedback identifier');
  object(m.authorization,['version','purpose','rights_confirmed','authorized_at','expires_at','external_processing','withdrawal_contact']);
  const a=m.authorization,authorized=date(a.authorized_at),expires=date(a.expires_at),exported=date(m.exported_at);
  check(m.authorization_version==='feedback-v2'&&a.version==='feedback-v2'&&a.purpose===m.purpose&&['support_review','quality_evaluation'].includes(m.purpose),'Feedback permission version or purpose is unsupported');
  check(a.rights_confirmed===true&&a.external_processing==='requires_separate_permission'&&a.withdrawal_contact==='raysyadesu@gmail.com','Feedback permission is incomplete');
  check(authorized<=exported&&exported<=now&&expires>now&&expires-authorized===90*86_400_000,'Feedback authorization is not current');
  check(m.retention==='local_until_user_deletes','Unexpected export retention');
  check(typeof m.answer==='string'&&m.answer.length>0&&Buffer.byteLength(m.answer)<=64*1024,'Invalid feedback answer');
  check(m.standard_answer===undefined||m.standard_answer===null||(typeof m.standard_answer==='string'&&Buffer.byteLength(m.standard_answer)<=16*1024),'Invalid reference answer');
  check(Array.isArray(m.assets)&&m.assets.length<=4,'Invalid feedback assets');
  let questions=0;
  m.assets.forEach((asset,index)=>{
    object(asset,['file','role','ordinal','sha256','widthPx','heightPx','byteCount']);
    check(['reference','question'].includes(asset.role)&&asset.ordinal===index,'Invalid material order');
    if(asset.role==='question'){questions++;check(index===m.assets.length-1,'Question must be the final asset');}
    const prefix='notchspi-feedback-'+m.submission_id.toLowerCase()+'-assets/'+String(index+1).padStart(2,'0')+'-'+asset.role;
    check(asset.file===prefix+'.jpg'||asset.file===prefix+'.png','Unsafe material path');
    check(typeof asset.sha256==='string'&&sha.test(asset.sha256)&&Number.isSafeInteger(asset.byteCount)&&asset.byteCount>0&&asset.byteCount<=2*1024*1024,'Invalid material digest or size');
    check(Number.isSafeInteger(asset.widthPx)&&Number.isSafeInteger(asset.heightPx)&&asset.widthPx>0&&asset.heightPx>0&&asset.widthPx<=16_000_000/asset.heightPx,'Invalid material dimensions');
  });
  check(questions<=1,'Multiple question assets');return m;
}

/** Private, offline operator storage. No remote intake, model call, telemetry join or email send. */
export class FeedbackVault {
  constructor(directory,{now=Date.now}={}){
    check(typeof directory==='string'&&path.isAbsolute(directory),'An absolute private vault directory is required');
    const parent=fs.realpathSync(path.dirname(directory));this.root=path.join(parent,path.basename(directory));this.now=now;
    check(this.root!==os.homedir()&&this.root!==parent&&!this.root.startsWith(repository+path.sep)&&this.root!==repository,'Keep received feedback outside the repository and a dedicated directory below home');
    if(!fs.existsSync(this.root))fs.mkdirSync(this.root,{mode:0o700});privateDirectory(this.root);
    this.cases=path.join(this.root,'cases');if(!fs.existsSync(this.cases))fs.mkdirSync(this.cases,{mode:0o700});privateDirectory(this.cases);
  }
  locked(work){
    const lock=path.join(this.root,'.lock');
    try{fs.mkdirSync(lock,{mode:0o700});}catch{throw new Error('Feedback vault is busy; inspect the live owner before recovering a lock');}
    try{fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});return work();}
    finally{fs.rmSync(lock,{recursive:true,force:true});}
  }
  casePath(id){check(typeof id==='string'&&uuid.test(id),'Invalid submission id');return path.join(this.cases,id.toLowerCase());}
  record(id){
    const directory=this.casePath(id);privateDirectory(directory);
    const record=parseJSON(readBounded(path.join(directory,'record.json'),128*1024));
    object(record,['version','id','manifestSha256','purpose','receivedAt','expiresAt','state','reviews','purge']);
    check(record.version===1&&record.id===id.toLowerCase()&&typeof record.manifestSha256==='string'&&sha.test(record.manifestSha256)&&
      ['support_review','quality_evaluation'].includes(record.purpose)&&['received','reviewed','purge_pending','withdrawn','expired'].includes(record.state)&&
      Array.isArray(record.reviews)&&record.reviews.length<=100,'Invalid vault record');
    check(date(record.receivedAt)<date(record.expiresAt),'Invalid vault retention');
    for(const review of record.reviews){
      object(review,['reference','reviewer','evidenceSha256','decision','recordedAt']);
      check([review.reference,review.reviewer].every(v=>typeof v==='string'&&reference.test(v))&&typeof review.evidenceSha256==='string'&&sha.test(review.evidenceSha256)&&
        ['support_checked','evaluation_approved'].includes(review.decision),'Invalid stored review');date(review.recordedAt);
    }
    check(new Set(record.reviews.map(r=>r.reference)).size===record.reviews.length,'Duplicate review reference');
    if(['received','reviewed'].includes(record.state))check(record.purge===null&&(record.state==='reviewed')===(record.reviews.length>0),'Invalid active review state');
    else{
      object(record.purge,['reason','reference','requestedAt','completedAt']);
      check(['withdrawal','expiry'].includes(record.purge.reason)&&typeof record.purge.reference==='string'&&reference.test(record.purge.reference),'Invalid purge record');date(record.purge.requestedAt);
      if(record.state==='purge_pending')check(record.purge.completedAt===null,'Invalid pending purge');
      else{check(record.state===(record.purge.reason==='withdrawal'?'withdrawn':'expired'),'Invalid completed purge');check(date(record.purge.completedAt)>=date(record.purge.requestedAt),'Invalid purge completion');}
    }
    return record;
  }
  verifyMaterial(record){
    const directory=path.join(this.casePath(record.id),'material');privateDirectory(directory);
    const bytes=readBounded(path.join(directory,'manifest.json'),128*1024);
    check(digest(bytes)===record.manifestSha256,'Stored feedback manifest changed');
    const manifest=validateFeedbackManifest(parseJSON(bytes),this.now());
    for(const asset of manifest.assets){
      const file=path.join(directory,asset.file);privateDirectory(path.dirname(file));
      const bytes=readBounded(file,2*1024*1024);check(bytes.length===asset.byteCount&&digest(bytes)===asset.sha256,'Stored feedback material changed');
    }
    return {manifest,directory};
  }
  ingest(manifestFile){return this.locked(()=>{
    const bytes=readBounded(manifestFile,128*1024),manifest=validateFeedbackManifest(parseJSON(bytes),this.now());
    const id=manifest.submission_id.toLowerCase(),destination=this.casePath(id),hash=digest(bytes);
    if(fs.existsSync(destination)){const previous=this.record(id);
      check(['received','reviewed'].includes(previous.state)&&previous.manifestSha256===hash,'Submission already exists with changed content or withdrawn permission');
      this.verifyMaterial(previous);return previous;
    }
    const staging=path.join(this.cases,'.staging-'+randomUUID());fs.mkdirSync(staging,{mode:0o700});
    try{
      const material=path.join(staging,'material');fs.mkdirSync(material,{mode:0o700});
      for(const asset of manifest.assets){
        const source=path.join(path.dirname(manifestFile),asset.file);
        check(!fs.lstatSync(path.dirname(source)).isSymbolicLink(),'Material directory must not be a symbolic link');
        const data=readBounded(source,2*1024*1024);check(data.length===asset.byteCount&&digest(data)===asset.sha256,'Exported material changed');
        const output=path.join(material,asset.file);fs.mkdirSync(path.dirname(output),{mode:0o700,recursive:true});
        fs.writeFileSync(output,data,{mode:0o600,flag:'wx'});
      }
      fs.writeFileSync(path.join(material,'manifest.json'),bytes,{mode:0o600,flag:'wx'});
      const record={version:1,id,manifestSha256:hash,purpose:manifest.purpose,receivedAt:new Date(this.now()).toISOString(),
        expiresAt:manifest.authorization.expires_at,state:'received',reviews:[],purge:null};
      atomicJSON(path.join(staging,'record.json'),record);fs.renameSync(staging,destination);return record;
    }finally{fs.rmSync(staging,{recursive:true,force:true});}
  });}
  review(id,decision){return this.locked(()=>{
    object(decision,['reference','reviewer','evidenceSha256','decision']);
    check([decision.reference,decision.reviewer].every(v=>typeof v==='string'&&reference.test(v))&&typeof decision.evidenceSha256==='string'&&sha.test(decision.evidenceSha256)&&
      ['support_checked','evaluation_approved'].includes(decision.decision),'Invalid independent review record');
    const record=this.record(id);check(['received','reviewed'].includes(record.state),'Permission has been withdrawn or expired');
    const {manifest}=this.verifyMaterial(record);
    if(decision.decision==='evaluation_approved')check(manifest.purpose==='quality_evaluation'&&manifest.assets.some(a=>a.role==='question')&&manifest.standard_answer?.trim(),'Quality use needs explicit purpose, question material and a reviewed reference answer');
    const prior=record.reviews.find(r=>r.reference===decision.reference);
    if(prior){check(Object.entries(decision).every(([k,v])=>prior[k]===v),'Review reference already used');return record;}
    check(record.reviews.length<100,'Review history limit reached');
    record.reviews.push({...decision,recordedAt:new Date(this.now()).toISOString()});record.state='reviewed';
    atomicJSON(path.join(this.casePath(id),'record.json'),record);return record;
  });}
  material(id){return this.locked(()=>{
    const record=this.record(id);check(record.state==='reviewed'&&record.reviews.at(-1)?.decision==='evaluation_approved','Evaluation use has not been approved');
    const {directory}=this.verifyMaterial(record);
    return {submission_id:record.id,manifest:path.join(directory,'manifest.json'),expires_at:record.expiresAt,external_processing:'requires_separate_permission'};
  });}
  purge(record,reason,auditReference){
    check(['withdrawal','expiry'].includes(reason)&&typeof auditReference==='string'&&reference.test(auditReference),'Invalid removal reason');
    if(['withdrawn','expired'].includes(record.state))return record;
    const file=path.join(this.casePath(record.id),'record.json');
    if(record.state!=='purge_pending'){
      record.state='purge_pending';record.purge={reason,reference:auditReference,requestedAt:new Date(this.now()).toISOString(),completedAt:null};atomicJSON(file,record);
    }
    fs.rmSync(path.join(this.casePath(record.id),'material'),{recursive:true,force:true});
    record.state=record.purge.reason==='withdrawal'?'withdrawn':'expired';record.purge.completedAt=new Date(this.now()).toISOString();atomicJSON(file,record);return record;
  }
  withdraw(id,auditReference){return this.locked(()=>this.purge(this.record(id),'withdrawal',auditReference));}
  prune(){return this.locked(()=>{
    let removed=0,active=0;
    for(const entry of fs.readdirSync(this.cases,{withFileTypes:true})){
      if(entry.name.startsWith('.staging-')&&uuid.test(entry.name.slice(9))){fs.rmSync(path.join(this.cases,entry.name),{recursive:true,force:true});continue;}
      if(!uuid.test(entry.name))continue;const record=this.record(entry.name);
      if(record.state==='purge_pending'||(!['withdrawn','expired'].includes(record.state)&&Date.parse(record.expiresAt)<=this.now())){
        this.purge(record,record.purge?.reason??'expiry',record.purge?.reference??'authorization-expired');removed++;
      }else if(['received','reviewed'].includes(record.state))active++;
    }
    return {removed,active};
  });}
}
