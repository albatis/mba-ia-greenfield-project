export const S3_CLIENT = 'S3_CLIENT';
export const S3_PRESIGN_CLIENT = 'S3_PRESIGN_CLIENT';

// Logical buckets; the physical names come from storageConfig
// (S3_VIDEOS_BUCKET / S3_THUMBNAILS_BUCKET).
export const STORAGE_BUCKETS = {
  VIDEOS: 'videos',
  THUMBNAILS: 'thumbnails',
} as const;

export type StorageBucket =
  (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

// S3 error names on CompleteMultipartUpload that mean the client sent a
// part list the storage refuses — surfaced as StoragePartsRejectedError.
export const S3_PARTS_REJECTED_ERRORS = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
] as const;
