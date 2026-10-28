import { join, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { FfprobeService } from './ffprobe.service';
import { MediaModule } from './media.module';
import { MediaCommandError } from './media-command';

const FIXTURES = resolve(__dirname, '../../test/fixtures/videos');
const fixture = (name: string): string => join(FIXTURES, name);

describe('FfprobeService (integration - ffprobe binary)', () => {
  let ffprobe: FfprobeService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();
    ffprobe = module.get(FfprobeService);
  });

  it('reads H.264 + AAC metadata from an MP4', async () => {
    const result = await ffprobe.probe(fixture('h264-aac-faststart.mp4'));

    expect(result).toEqual({
      durationSeconds: expect.any(Number) as number,
      formatName: expect.stringContaining('mp4') as string,
      videoStream: { codecName: 'h264', width: 160, height: 120 },
      audioStream: { codecName: 'aac' },
    });
    expect(result.durationSeconds).toBeGreaterThan(0);
  });

  it('reads VP9 + Opus metadata from a WebM', async () => {
    const result = await ffprobe.probe(fixture('vp9-opus.webm'));

    expect(result.formatName).toContain('webm');
    expect(result.videoStream).toEqual({
      codecName: 'vp9',
      width: 160,
      height: 120,
    });
    expect(result.audioStream).toEqual({ codecName: 'opus' });
    expect(result.durationSeconds).toBeGreaterThan(0);
  });

  it('returns a null audioStream for a video-only file', async () => {
    const result = await ffprobe.probe(fixture('hevc.mp4'));

    expect(result.videoStream.codecName).toBe('hevc');
    expect(result.audioStream).toBeNull();
  });

  it('fails with MediaCommandError carrying ffprobe stderr for a non-video file', async () => {
    const failure = ffprobe.probe(fixture('not-a-video.mp4'));

    await expect(failure).rejects.toBeInstanceOf(MediaCommandError);
    await expect(failure).rejects.toThrow(/Invalid data found/);
  });
});
