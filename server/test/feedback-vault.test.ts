import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// The production operator utility is plain Node JavaScript; exercise its runtime boundaries.
const {FeedbackVault}=await import(new URL('../../scripts/lib/feedback-vault.mjs',import.meta.url).href);
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
function fixture(purpose='quality_evaluation',now=Date.now()){
  const root=fs.mkdtempSync(join(tmpdir(),'feedback-vault-test-')),input=join(root,'export');fs.mkdirSync(input,{mode:0o700});
  const id=randomUUID(),directory='notchspi-feedback-'+id+'-assets';fs.mkdirSync(join(input,directory),{mode:0o700});
  const bytes=Buffer.from([255,216,255,217]),file=directory+'/01-question.jpg';fs.writeFileSync(join(input,file),bytes,{mode:0o600});
  const manifest={submission_id:id,authorization_version:'feedback-v2',authorization:{version:'feedback-v2',purpose,rights_confirmed:true,
    authorized_at:new Date(now-1000).toISOString(),expires_at:new Date(now-1000+90*86_400_000).toISOString(),external_processing:'requires_separate_permission',withdrawal_contact:'raysyadesu@gmail.com'},
    purpose,retention:'local_until_user_deletes',exported_at:new Date(now-500).toISOString(),capture_id:randomUUID(),session_id:randomUUID(),
    answer:'private visible answer',standard_answer:'reviewed reference answer',assets:[{file,role:'question',ordinal:0,sha256:digest(bytes),widthPx:2,heightPx:2,byteCount:bytes.length}]};
  const path=join(input,'feedback.json');fs.writeFileSync(path,JSON.stringify(manifest),{mode:0o600});
  return {root,input,id,path,manifest,vault:join(root,'private-vault'),cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
const decision={reference:'review-1',reviewer:'fixture-reviewer',evidenceSha256:'a'.repeat(64),decision:'evaluation_approved'};
test('feedback vault preserves support-only permission and keeps the evidence outside operational metadata',()=>{
  const f=fixture('support_review');try{
    const vault=new FeedbackVault(f.vault),first=vault.ingest(f.path);assert.deepEqual(vault.ingest(f.path),first);
    assert.equal(first.state,'received');assert.doesNotMatch(JSON.stringify(first),/private visible|reference answer|capture_id|session_id/);
    assert.throws(()=>vault.material(f.id),/not been approved/);assert.throws(()=>vault.review(f.id,decision),/explicit purpose/);
    const reviewed=vault.review(f.id,{...decision,decision:'support_checked'});assert.equal(reviewed.reviews.length,1);
    assert.throws(()=>vault.material(f.id),/not been approved/);assert.equal(fs.statSync(f.vault).mode&0o077,0);
  }finally{f.cleanup();}
});
test('quality approval binds reviewed content, is idempotent, and never authorizes external model processing',()=>{
  const f=fixture();try{
    const vault=new FeedbackVault(f.vault);vault.ingest(f.path);vault.review(f.id,decision);
    assert.equal(vault.review(f.id,decision).reviews.length,1);assert.throws(()=>vault.review(f.id,{...decision,evidenceSha256:'b'.repeat(64)}),/reference already used/);
    const output=vault.material(f.id);assert.equal(output.external_processing,'requires_separate_permission');assert.ok(output.manifest.startsWith(vault.root));
    fs.writeFileSync(join(vault.root,'cases',f.id,'material',f.manifest.assets[0]!.file),'changed');
    assert.throws(()=>vault.material(f.id),/material changed/);
  }finally{f.cleanup();}
});
test('withdrawal deletes received material, retains a minimal audit and cannot reactivate the same submission',()=>{
  const f=fixture();try{
    const vault=new FeedbackVault(f.vault);vault.ingest(f.path);vault.review(f.id,decision);
    const result=vault.withdraw(f.id,'withdrawal-confirmed');assert.equal(result.state,'withdrawn');assert.ok(result.purge.completedAt);
    assert.equal(fs.existsSync(join(vault.root,'cases',f.id,'material')),false);assert.ok(fs.existsSync(f.path),'the user owns their original export');
    assert.doesNotMatch(JSON.stringify(vault.record(f.id)),/private visible|reviewed reference answer/);
    assert.deepEqual(vault.withdraw(f.id,'withdrawal-confirmed'),result);
    assert.throws(()=>vault.material(f.id));assert.throws(()=>vault.ingest(f.path),/already exists/);
  }finally{f.cleanup();}
});
test('expiry denies use before cleanup and pruning removes received material and interrupted staging',()=>{
  let now=Date.now();const f=fixture('quality_evaluation',now);try{
    const vault=new FeedbackVault(f.vault,{now:()=>now});vault.ingest(f.path);vault.review(f.id,decision);
    const stage=join(vault.root,'cases','.staging-'+randomUUID());fs.mkdirSync(stage,{mode:0o700});fs.writeFileSync(join(stage,'partial'),'partial received data');
    now+=91*86_400_000;assert.throws(()=>vault.material(f.id),/not current/);
    assert.deepEqual(vault.prune(),{removed:1,active:0});assert.equal(fs.existsSync(stage),false);assert.equal(vault.record(f.id).state,'expired');
    assert.equal(fs.existsSync(join(vault.root,'cases',f.id,'material')),false);assert.deepEqual(vault.prune(),{removed:0,active:0});
  }finally{f.cleanup();}
});
test('failed removal blocks access immediately and a later sweep resumes the recorded deletion',()=>{
  const f=fixture();try{
    const vault=new FeedbackVault(f.vault);vault.ingest(f.path);vault.review(f.id,decision);
    const remove=fs.rmSync,intercept=mock.method(fs,'rmSync',((path:fs.PathLike,options:fs.RmOptions)=>{
      if(String(path)===join(vault.root,'cases',f.id,'material'))throw new Error('injected removal failure');return remove(path,options);
    }) as typeof fs.rmSync);
    try{assert.throws(()=>vault.withdraw(f.id,'withdrawal-retry'),/injected/);assert.equal(vault.record(f.id).state,'purge_pending');assert.throws(()=>vault.material(f.id));}
    finally{intercept.mock.restore();}
    assert.equal(vault.prune().removed,1);assert.equal(vault.record(f.id).state,'withdrawn');assert.equal(fs.existsSync(join(vault.root,'cases',f.id,'material')),false);
  }finally{f.cleanup();}
});
test('unconsented, changed and symbolic-link exports never become reviewable cases',()=>{
  const f=fixture();try{
    const vault=new FeedbackVault(f.vault),write=(value:unknown)=>fs.writeFileSync(f.path,JSON.stringify(value));
    write({...f.manifest,authorization:{...f.manifest.authorization,rights_confirmed:false}});assert.throws(()=>vault.ingest(f.path),/incomplete/);
    write({...f.manifest,device_token:'must-not-store'});assert.throws(()=>vault.ingest(f.path),/Unexpected/);
    write(f.manifest);const asset=join(f.input,f.manifest.assets[0]!.file);fs.rmSync(asset);fs.symlinkSync(f.path,asset);assert.throws(()=>vault.ingest(f.path));
    assert.deepEqual(fs.readdirSync(join(vault.root,'cases')),[]);
    fs.chmodSync(f.vault,0o755);assert.throws(()=>new FeedbackVault(f.vault),/private directory/);
  }finally{f.cleanup();}
});
test('operator CLI runs the reviewed workflow without printing feedback contents',()=>{
  const f=fixture(),script=fileURLToPath(new URL('../../scripts/manage-feedback.mjs',import.meta.url));try{
    const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,[script,'--vault',resolve(f.vault),...args],{encoding:'utf8'}));
    assert.equal(run('ingest','--manifest',f.path).state,'received');
    assert.equal(run('review','--id',f.id,'--reference','cli-review','--reviewer','fixture-reviewer','--evidence-sha256','b'.repeat(64),'--decision','evaluation_approved').state,'reviewed');
    assert.ok(run('material','--id',f.id).manifest);
    assert.equal(run('withdraw','--id',f.id,'--reference','cli-withdrawal').state,'withdrawn');
    assert.doesNotMatch(JSON.stringify(run('status','--id',f.id)),/private visible|reviewed reference/);
  }finally{f.cleanup();}
});
test('malformed input and stored audit cannot leak content or silently extend authorization',()=>{
  const f=fixture(),script=fileURLToPath(new URL('../../scripts/manage-feedback.mjs',import.meta.url));try{
    fs.writeFileSync(f.path,'{"answer":"private malformed feedback" trailing}');
    const result=spawnSync(process.execPath,[script,'--vault',f.vault,'ingest','--manifest',f.path],{encoding:'utf8'});
    assert.equal(result.status,1);assert.match(result.stderr,/Invalid feedback JSON/);
    assert.doesNotMatch(result.stderr+result.stdout,/private malformed feedback/);
    fs.writeFileSync(f.path,JSON.stringify(f.manifest));const vault=new FeedbackVault(f.vault);vault.ingest(f.path);
    const recordPath=join(f.vault,'cases',f.id,'record.json');
    const record=JSON.parse(fs.readFileSync(recordPath,'utf8'));record.expiresAt='invalid';fs.writeFileSync(recordPath,JSON.stringify(record));
    assert.throws(()=>vault.prune(),/Invalid feedback time/);
    assert.throws(()=>vault.material(f.id),/Invalid feedback time/);
  }finally{f.cleanup();}
});
