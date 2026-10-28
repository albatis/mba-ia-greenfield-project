import { open } from 'node:fs/promises';

const BOX_HEADER_BYTES = 8;
const LARGE_SIZE_BYTES = 8;

/**
 * True when the MP4's `mdat` box comes before `moov`, i.e. the player must
 * download the whole media data before it can start. Reads only the headers
 * of the top-level boxes.
 */
export async function needsFaststart(filePath: string): Promise<boolean> {
  const file = await open(filePath, 'r');
  try {
    const { size: fileSize } = await file.stat();
    const header = Buffer.alloc(BOX_HEADER_BYTES + LARGE_SIZE_BYTES);
    let offset = 0;

    while (offset + BOX_HEADER_BYTES <= fileSize) {
      const { bytesRead } = await file.read(header, 0, header.length, offset);
      if (bytesRead < BOX_HEADER_BYTES) {
        break;
      }

      const type = header.toString('latin1', 4, 8);
      if (type === 'moov') {
        return false;
      }
      if (type === 'mdat') {
        return true;
      }

      let boxSize = header.readUInt32BE(0);
      if (boxSize === 1) {
        // 64-bit size follows the type
        if (bytesRead < BOX_HEADER_BYTES + LARGE_SIZE_BYTES) {
          break;
        }
        boxSize = Number(header.readBigUInt64BE(BOX_HEADER_BYTES));
      } else if (boxSize === 0) {
        // Box extends to the end of the file
        break;
      }
      if (boxSize < BOX_HEADER_BYTES) {
        break;
      }
      offset += boxSize;
    }
    return false;
  } finally {
    await file.close();
  }
}
