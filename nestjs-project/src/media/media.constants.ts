// Upper bounds for the system ffmpeg/ffprobe calls; a command past its limit
// is killed. Remux copies streams without re-encoding but may read up to 10GB.
export const MEDIA_TIMEOUTS_MS = {
  PROBE: 60_000,
  THUMBNAIL: 60_000,
  REMUX: 30 * 60_000,
} as const;
