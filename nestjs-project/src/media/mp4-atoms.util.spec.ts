import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { needsFaststart } from './mp4-atoms.util';

const FIXTURES = resolve(__dirname, '../../test/fixtures/videos');

function box(type: string, payloadBytes: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payloadBytes, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, Buffer.alloc(payloadBytes)]);
}

function largeBox(type: string, payloadBytes: number): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'latin1');
  header.writeBigUInt64BE(BigInt(16 + payloadBytes), 8);
  return Buffer.concat([header, Buffer.alloc(payloadBytes)]);
}

describe('needsFaststart', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mp4-atoms-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const writeBoxes = async (name: string, boxes: Buffer[]): Promise<string> => {
    const path = join(workDir, name);
    await writeFile(path, Buffer.concat(boxes));
    return path;
  };

  it('returns true for an MP4 with moov after mdat', async () => {
    await expect(
      needsFaststart(join(FIXTURES, 'h264-aac-moov-end.mp4')),
    ).resolves.toBe(true);
  });

  it('returns false for a faststart MP4', async () => {
    await expect(
      needsFaststart(join(FIXTURES, 'h264-aac-faststart.mp4')),
    ).resolves.toBe(false);
  });

  it('follows 64-bit box sizes to find mdat before moov', async () => {
    const path = await writeBoxes('large-free.mp4', [
      box('ftyp', 16),
      largeBox('free', 32),
      box('mdat', 64),
      box('moov', 16),
    ]);

    await expect(needsFaststart(path)).resolves.toBe(true);
  });

  it('returns false when the file has neither moov nor mdat', async () => {
    const path = await writeBoxes('no-media.mp4', [box('ftyp', 16)]);

    await expect(needsFaststart(path)).resolves.toBe(false);
  });
});
