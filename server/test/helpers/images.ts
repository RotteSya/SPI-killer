import {crc32,deflateSync} from 'node:zlib';

export function pngChunk(kind:string,data:Buffer):Buffer {
  const chunk=Buffer.alloc(data.length+12);
  chunk.writeUInt32BE(data.length);chunk.write(kind,4,'ascii');data.copy(chunk,8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);return chunk;
}
// A complete independent 2x2 RGB PNG fixture: filter byte + six pixel bytes per scanline.
const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
export const pngBytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),
  pngChunk('IDAT',deflateSync(Buffer.from([0,255,255,255,0,0,0,0,0,0,0,255,255,255]))),pngChunk('IEND',Buffer.alloc(0))]);
export const pngBase64=pngBytes.toString('base64');
export function corruptPixels():Buffer {
  const output=Buffer.from(pngBytes),offset=33,length=output.readUInt32BE(offset);
  output.fill(0,offset+8,offset+8+length);
  output.writeUInt32BE(crc32(output.subarray(offset+4,offset+8+length)),offset+8+length);
  return output;
}
