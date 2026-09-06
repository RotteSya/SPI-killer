import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import sharp from 'sharp';
import {imageDigest,imageDigests} from '../src/image-validation.ts';
import {pngBytes,pngBase64,pngChunk,corruptPixels} from './helpers/images.ts';
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const invalid={name:'ApiError',code:'invalid_image',statusCode:422};

test('complete PNG, baseline and progressive JPEG retain the exact original-byte digest',async()=>{
  assert.equal(await imageDigest(pngBase64,'image/png'),digest(pngBytes));
  for(const progressive of [false,true]){
    const bytes=await sharp(pngBytes).resize(32,32).jpeg({progressive}).toBuffer();
    assert.equal(await imageDigest(bytes.toString('base64'),'image/jpeg'),digest(bytes));
  }
  const rgba=await sharp(pngBytes).ensureAlpha().png().toBuffer();
  assert.equal(await imageDigest(rgba.toString('base64'),'image/png'),digest(rgba));
});
test('valid PNG container checksums do not hide broken compressed pixel data',async()=>{
  const bad=corruptPixels();
  assert.equal(bad.readUInt32BE(16),2);assert.equal(bad.readUInt32BE(20),2);
  await assert.rejects(()=>imageDigest(bad.toString('base64'),'image/png'),invalid);
  const crc=Buffer.from(pngBytes);crc[29]=crc[29]!^1;
  await assert.rejects(()=>imageDigest(crc.toString('base64'),'image/png'),invalid);
});
test('declared type, static-image boundaries, end markers and canonical base64 are enforced',async()=>{
  const animation=Buffer.concat([pngBytes.subarray(0,33),pngChunk('acTL',Buffer.from([0,0,0,2,0,0,0,0])),pngBytes.subarray(33)]);
  const jpeg=await sharp(pngBytes).jpeg().toBuffer();
  for(const [bytes,mime] of [[pngBytes,'image/jpeg'],[jpeg,'image/png'],[pngBytes,'image/webp'],[animation,'image/png'],
    [Buffer.concat([pngBytes,Buffer.from('extra')]),'image/png'],[Buffer.concat([jpeg,jpeg]),'image/jpeg'],
    [jpeg.subarray(0,-2),'image/jpeg']] as const)await assert.rejects(()=>imageDigest(bytes.toString('base64'),mime),invalid);
  await assert.rejects(()=>imageDigest(pngBase64+'\n','image/png'),invalid);
  await assert.rejects(()=>imageDigest('A'.repeat(8*1024*1024+4),'image/png'),invalid);
});
test('16 megapixels is accepted and oversized decoded dimensions are refused before allocation',async()=>{
  const full=await sharp({create:{width:4000,height:4000,channels:3,background:'#ffffff'}}).png().toBuffer();
  assert.equal(await imageDigest(full.toString('base64'),'image/png'),digest(full));
  const oversized=Buffer.from(pngBytes);oversized.writeUInt32BE(4001,16);oversized.writeUInt32BE(4000,20);
  oversized.writeUInt32BE(crc32(oversized.subarray(12,29)),29);
  await assert.rejects(()=>imageDigest(oversized.toString('base64'),'image/png'),invalid);
});
test('ordered image batches preserve duplicate pages and release capacity after an invalid image',async()=>{
  const jpeg=await sharp(pngBytes).jpeg().toBuffer();
  const images=[pngBytes,jpeg,pngBytes,jpeg].map((bytes,i)=>({base64:bytes.toString('base64'),mediaType:i%2?'image/jpeg':'image/png'}));
  assert.deepEqual(await imageDigests(images),[digest(pngBytes),digest(jpeg),digest(pngBytes),digest(jpeg)]);
  await assert.rejects(()=>imageDigests([...images,{base64:corruptPixels().toString('base64'),mediaType:'image/png'}]),invalid);
  assert.equal(await imageDigest(pngBase64,'image/png'),digest(pngBytes));
});
test('process-wide decoder admission is bounded without an unbounded waiting queue',async()=>{
  const results=await Promise.allSettled([imageDigest(pngBase64,'image/png'),imageDigest(pngBase64,'image/png'),imageDigest(pngBase64,'image/png')]);
  assert.equal(results[0]?.status,'fulfilled');assert.equal(results[1]?.status,'fulfilled');
  const third=results[2];assert.equal(third?.status,'rejected');
  if(third?.status==='rejected'){assert.equal(third.reason.code,'rate_limited');assert.equal(third.reason.statusCode,503);}
  assert.equal(await imageDigest(pngBase64,'image/png'),digest(pngBytes));
});
