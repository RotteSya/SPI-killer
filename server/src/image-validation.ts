import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import sharp, {type Sharp} from 'sharp';
import {ApiError} from './http.ts';

const MAX_BASE64=8*1024*1024, MAX_PIXELS=16_000_000;
// Do not retain decoded question images in libvips' cross-request operation cache.
sharp.cache(false);
sharp.concurrency(1);
let activeDecoders=0;
const invalid=()=>new ApiError(422,'图片格式、尺寸或完整性无效，请重新截图','invalid_image');

function pngContainer(data:Buffer):boolean {
  if(data.length<45||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
  let offset=8,seenData=false,chunks=0;
  while(offset+12<=data.length&&++chunks<=4096){
    const length=data.readUInt32BE(offset),kind=data.toString('ascii',offset+4,offset+8);
    if(length>data.length-offset-12)return false;
    if(chunks===1&&(kind!=='IHDR'||length!==13))return false;
    if(chunks>1&&kind==='IHDR'||['acTL','fcTL','fdAT'].includes(kind))return false;
    if(crc32(data.subarray(offset+4,offset+8+length))!==data.readUInt32BE(offset+8+length))return false;
    if(kind==='IDAT')seenData=true;
    offset+=length+12;
    if(kind==='IEND')return seenData&&length===0&&offset===data.length;
  }
  return false;
}

function jpegContainer(data:Buffer):boolean {
  if(data.length<4||data[0]!==255||data[1]!==216)return false;
  let offset=2,scan=false,seenScan=false;
  while(offset<data.length){
    if(scan){
      while(offset<data.length&&data[offset]!==255)offset++;
      if(offset>=data.length)return false;
    }
    if(data[offset++]!==255)return false;
    while(data[offset]===255)offset++;
    const marker=data[offset++];
    if(scan&&(marker===0||(marker!==undefined&&marker>=208&&marker<=215)))continue;
    scan=false;
    if(marker===217)return seenScan&&offset===data.length;
    if(marker===undefined||marker===0||marker===216||marker>=208&&marker<=215||offset+2>data.length)return false;
    const length=data.readUInt16BE(offset);
    if(length<2||length>data.length-offset)return false;
    offset+=length;
    if(marker===218){scan=true;seenScan=true;}
  }
  return false;
}

/** Validate a complete static image, then digest the original decoded bytes without re-encoding. */
export async function imageDigest(base64:string,mediaType:string):Promise<string> {
  if(base64.length===0||base64.length>MAX_BASE64||base64.length%4!==0||/[^A-Za-z0-9+/=]/.test(base64))throw invalid();
  if(activeDecoders>=2)throw new ApiError(503,'图片校验繁忙，请稍后重试','rate_limited');
  activeDecoders++;
  let decoder:Sharp|undefined;
  try {
    const data=Buffer.from(base64,'base64');
    if(data.toString('base64')!==base64)throw invalid();
    const format=mediaType==='image/png'&&pngContainer(data)?'png':mediaType==='image/jpeg'&&jpegContainer(data)?'jpeg':null;
    if(!format)throw invalid();
    decoder=sharp(data,{failOn:'warning',limitInputPixels:MAX_PIXELS,limitInputChannels:4,sequentialRead:true}).timeout({seconds:5});
    const metadata=await decoder.metadata();
    if(metadata.format!==format||!metadata.width||!metadata.height||metadata.width>MAX_PIXELS/metadata.height||(metadata.pages??1)!==1)throw invalid();
    // metadata() alone does not decode pixel data. Consume the full bounded image without resizing.
    const {data:pixels,info}=await decoder.raw({depth:'uchar'}).toBuffer({resolveWithObject:true});
    const complete=info.width===metadata.width&&info.height===metadata.height&&info.channels<=4&&pixels.length===info.width*info.height*info.channels;
    pixels.fill(0);
    if(!complete)throw invalid();
    return createHash('sha256').update(data).digest('hex');
  }catch {throw invalid();}
  finally {decoder?.destroy();activeDecoders--;}
}

/** Each request decodes in page order, bounding per-request memory independently of image count. */
export async function imageDigests(images:readonly {base64:string;mediaType:string}[]):Promise<string[]> {
  const result:string[]=[];
  for(const image of images)result.push(await imageDigest(image.base64,image.mediaType));
  return result;
}
