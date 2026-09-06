#!/usr/bin/env node
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {uploadQualityRecord} from './lib/quality-upload.mts';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--file')throw new Error('Usage: node scripts/upload-quality-report.mjs --file <prepared-quality-json>');
const base=process.env.NSPI_QUALITY_BASE_URL,token=process.env.NSPI_QUALITY_ADMIN_TOKEN;
if(!base||!token)throw new Error('NSPI_QUALITY_BASE_URL and NSPI_QUALITY_ADMIN_TOKEN must explicitly name the destination and its credential');
const path=resolve(args[1]);if((await stat(path)).size>2*1024*1024)throw new Error('Quality input exceeds 2 MiB');
const raw=JSON.parse(await readFile(path,'utf8'));
console.log(JSON.stringify(await uploadQualityRecord(raw,base,token)));
