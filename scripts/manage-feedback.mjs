#!/usr/bin/env node
import {FeedbackVault} from './lib/feedback-vault.mjs';

const usage='Usage: node scripts/manage-feedback.mjs --vault /absolute/private/folder <ingest|review|material|withdraw|status|prune> [--manifest file] [--id UUID] [--reference id] [--reviewer id] [--evidence-sha256 SHA256] [--decision support_checked|evaluation_approved]';
try{
  const args=process.argv.slice(2),options={};let action;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg.startsWith('--')){const key=arg.slice(2);if(!['vault','manifest','id','reference','reviewer','evidence-sha256','decision'].includes(key)||Object.hasOwn(options,key)||!args[i+1]||args[i+1].startsWith('--'))throw new Error(usage);options[key]=args[++i];}
    else if(action)throw new Error(usage);else action=arg;
  }
  const allowed={ingest:['vault','manifest'],review:['vault','id','reference','reviewer','evidence-sha256','decision'],material:['vault','id'],withdraw:['vault','id','reference'],status:['vault','id'],prune:['vault']};
  if(!allowed[action]||Object.keys(options).length!==allowed[action].length||!allowed[action].every(k=>options[k]))throw new Error(usage);
  const vault=new FeedbackVault(options.vault);
  const result=action==='ingest'?vault.ingest(options.manifest):action==='review'?vault.review(options.id,{reference:options.reference,reviewer:options.reviewer,evidenceSha256:options['evidence-sha256'],decision:options.decision}):
    action==='material'?vault.material(options.id):action==='withdraw'?vault.withdraw(options.id,options.reference):action==='prune'?vault.prune():vault.record(options.id);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){process.stderr.write((error instanceof Error?error.message:'Feedback operation failed')+'\n');process.exitCode=1;}
