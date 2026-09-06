#!/usr/bin/env node
// Offline conversion only. It does not load environment credentials, call models or upload data.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareLegacyQuality} from './lib/legacy-quality-import.mts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];if(!['--attestation','--treatment-jsonl','--baseline-jsonl','--out'].includes(name)||!value||options[name])throw new Error('Expected --attestation, --treatment-jsonl, --baseline-jsonl and --out paths');options[name]=value;}
for(const key of ['--attestation','--treatment-jsonl','--baseline-jsonl','--out'])if(!options[key])throw new Error('Missing '+key);
const result=await prepareLegacyQuality({root,attestation:options['--attestation'],treatmentRows:options['--treatment-jsonl'],baselineRows:options['--baseline-jsonl']});
const output=resolve(root,options['--out']);await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(result.submission,null,2)+'\n',{flag:'wx',mode:0o600});
await writeFile(output+'.provenance.json',JSON.stringify(result.provenance,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,provenance:output+'.provenance.json',samples:result.submission.cases.length,paid_calls:0}));
