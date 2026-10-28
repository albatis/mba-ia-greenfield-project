import type { VideoResponseDto } from './dto/video-response.dto';
import type { Video } from './entities/video.entity';

export function toVideoResponse(
  video: Video,
  thumbnailsPublicBaseUrl: string,
): VideoResponseDto {
  return {
    videoId: video.public_id,
    processingStatus: video.processing_status,
    publicationStatus: video.publication_status,
    originalFilename: video.original_filename,
    mimeType: video.mime_type,
    sizeBytes: video.size_bytes,
    durationSeconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    thumbnailUrl: video.thumbnail_key
      ? `${thumbnailsPublicBaseUrl.replace(/\/+$/, '')}/${video.thumbnail_key}`
      : null,
    failureReason: video.failure_reason,
    createdAt: video.created_at.toISOString(),
  };
}
