import type { ProbeResult } from '../media/ffprobe.service';
import type { ALLOWED_VIDEO_MIME_TYPES } from './videos.constants';

type AllowedVideoMimeType = (typeof ALLOWED_VIDEO_MIME_TYPES)[number];

interface PlayableCodecs {
  /** Token expected in ffprobe's comma-separated format_name */
  format: string;
  videoCodec: string;
  /** Audio is optional; when present it must be this codec */
  audioCodec: string;
}

// Browser-playable combinations, served as-is without transcoding (per TD-09)
const PLAYABLE_CODECS: Record<AllowedVideoMimeType, PlayableCodecs> = {
  'video/mp4': { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
  'video/webm': { format: 'webm', videoCodec: 'vp9', audioCodec: 'opus' },
};

export function isPlayableCodec(mimeType: string, probe: ProbeResult): boolean {
  const allowed: PlayableCodecs | undefined =
    PLAYABLE_CODECS[mimeType as AllowedVideoMimeType];
  if (!allowed) {
    return false;
  }
  return (
    probe.formatName.split(',').includes(allowed.format) &&
    probe.videoStream.codecName === allowed.videoCodec &&
    (probe.audioStream === null ||
      probe.audioStream.codecName === allowed.audioCodec)
  );
}
