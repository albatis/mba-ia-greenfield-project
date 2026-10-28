import { Injectable } from '@nestjs/common';
import { MEDIA_TIMEOUTS_MS } from './media.constants';
import { runMediaCommand } from './media-command';

const BASE_ARGS = ['-v', 'error', '-nostdin', '-y'] as const;

@Injectable()
export class FfmpegService {
  /** Writes one JPEG frame taken at `atSeconds` */
  async extractThumbnail(
    input: string,
    output: string,
    atSeconds: number,
    timeoutMs: number = MEDIA_TIMEOUTS_MS.THUMBNAIL,
  ): Promise<void> {
    await runMediaCommand(
      'ffmpeg',
      [
        ...BASE_ARGS,
        // Seeking before -i jumps to the nearest keyframe without decoding up to it
        '-ss',
        String(atSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-c:v',
        'mjpeg',
        '-q:v',
        '3',
        '-f',
        'image2',
        '-update',
        '1',
        output,
      ],
      timeoutMs,
    );
  }

  /** Rewrites an MP4 with moov before mdat, copying streams without re-encoding */
  async remuxFaststart(
    input: string,
    output: string,
    timeoutMs: number = MEDIA_TIMEOUTS_MS.REMUX,
  ): Promise<void> {
    await runMediaCommand(
      'ffmpeg',
      [
        ...BASE_ARGS,
        '-i',
        input,
        '-map',
        '0',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        output,
      ],
      timeoutMs,
    );
  }
}
