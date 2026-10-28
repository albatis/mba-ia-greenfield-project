import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { FfmpegService } from './ffmpeg.service';
import { FfprobeService } from './ffprobe.service';
import { MediaModule } from './media.module';
import { MediaCommandError, runMediaCommand } from './media-command';
import { needsFaststart } from './mp4-atoms.util';

const FIXTURES = resolve(__dirname, '../../test/fixtures/videos');
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Command lines of every live process in this container */
async function runningCommandLines(): Promise<string[]> {
  const lines: string[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const raw = await readFile(`/proc/${entry}/cmdline`);
      lines.push(raw.toString('utf8').replace(/\0/g, ' '));
    } catch {
      // The process exited while scanning
    }
  }
  return lines;
}

describe('FfmpegService (integration - ffmpeg binary)', () => {
  let ffmpeg: FfmpegService;
  let ffprobe: FfprobeService;
  let workDir: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();
    ffmpeg = module.get(FfmpegService);
    ffprobe = module.get(FfprobeService);
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('extracts a decodable JPEG frame', async () => {
    const output = join(workDir, 'thumb.jpg');

    await ffmpeg.extractThumbnail(
      join(FIXTURES, 'h264-aac-faststart.mp4'),
      output,
      0.5,
    );

    const bytes = await readFile(output);
    expect(bytes.subarray(0, 3)).toEqual(JPEG_MAGIC);
    const probed = await ffprobe.probe(output);
    expect(probed.videoStream).toEqual({
      codecName: 'mjpeg',
      width: 160,
      height: 120,
    });
  });

  it('remuxes a moov-at-end MP4 into faststart with the same duration', async () => {
    const input = join(FIXTURES, 'h264-aac-moov-end.mp4');
    const output = join(workDir, 'faststart.mp4');
    expect(await needsFaststart(input)).toBe(true);

    await ffmpeg.remuxFaststart(input, output);

    expect(await needsFaststart(output)).toBe(false);
    const [original, remuxed] = await Promise.all([
      ffprobe.probe(input),
      ffprobe.probe(output),
    ]);
    expect(remuxed.durationSeconds).toBeCloseTo(original.durationSeconds!, 2);
    expect(remuxed.videoStream).toEqual(original.videoStream);
    expect(remuxed.audioStream).toEqual(original.audioStream);
  });

  it('fails with MediaCommandError for an input that is not a video', async () => {
    const output = join(workDir, 'never.jpg');

    await expect(
      ffmpeg.extractThumbnail(join(FIXTURES, 'not-a-video.mp4'), output, 0),
    ).rejects.toBeInstanceOf(MediaCommandError);
    await expect(stat(output)).rejects.toThrow();
  });

  it('kills a command past its timeout and leaves no process behind', async () => {
    // Endless synthetic input; the odd frame size marks this process
    const marker = 'testsrc=size=161x97';

    const run = runMediaCommand(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        marker,
        '-f',
        'null',
        '-',
      ],
      300,
    );

    await expect(run).rejects.toBeInstanceOf(MediaCommandError);
    await expect(run).rejects.toThrow(/timed out after 300ms/);

    const survivors = (await runningCommandLines()).filter((line) =>
      line.includes(marker),
    );
    expect(survivors).toEqual([]);
  });
});
