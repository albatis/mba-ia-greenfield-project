export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';
export const CLEANUP_ABANDONED_UPLOADS_JOB = 'cleanup-abandoned-uploads';

export type ProcessVideoJobData = {
  /** Internal videos.id (UUID), never the public ID */
  videoId: string;
};
