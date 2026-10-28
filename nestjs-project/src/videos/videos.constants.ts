// Containers the browser can play natively (per TD-09); codecs are checked by the worker
export const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;

// Collisions on 66 random bits are practically impossible; the retry only
// guards against the theoretical case (per TD-11)
export const PUBLIC_ID_MAX_ATTEMPTS = 3;
