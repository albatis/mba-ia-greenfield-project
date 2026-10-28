import { Injectable } from '@nestjs/common';
import { MEDIA_TIMEOUTS_MS } from './media.constants';
import { MediaCommandError, runMediaCommand } from './media-command';

export interface ProbeResult {
  /** null when the container does not declare a duration */
  durationSeconds: number | null;
  /** ffprobe's format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm" */
  formatName: string;
  videoStream: { codecName: string; width: number; height: number };
  audioStream: { codecName: string } | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
}

@Injectable()
export class FfprobeService {
  /** Throws MediaCommandError on a failed run, invalid output or no video stream */
  async probe(
    filePath: string,
    timeoutMs: number = MEDIA_TIMEOUTS_MS.PROBE,
  ): Promise<ProbeResult> {
    const stdout = await runMediaCommand(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      timeoutMs,
    );

    let output: FfprobeOutput;
    try {
      output = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new MediaCommandError('ffprobe', 'returned invalid JSON', '');
    }

    const streams = output.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    if (!video?.codec_name || !video.width || !video.height) {
      throw new MediaCommandError('ffprobe', 'found no video stream', '');
    }

    const duration = Number(output.format?.duration);
    return {
      durationSeconds: Number.isFinite(duration) ? duration : null,
      formatName: output.format?.format_name ?? '',
      videoStream: {
        codecName: video.codec_name,
        width: video.width,
        height: video.height,
      },
      audioStream: audio?.codec_name ? { codecName: audio.codec_name } : null,
    };
  }
}
