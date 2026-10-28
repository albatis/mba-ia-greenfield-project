export enum VideoProcessingStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

// 'published' arrives in Phase 04
export enum VideoPublicationStatus {
  DRAFT = 'draft',
}

export enum VideoFailureReason {
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  UNSUPPORTED_CODEC = 'UNSUPPORTED_CODEC',
  PROBE_FAILED = 'PROBE_FAILED',
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  UPLOAD_ABANDONED = 'UPLOAD_ABANDONED',
}
