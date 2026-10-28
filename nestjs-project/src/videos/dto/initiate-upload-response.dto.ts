import { ApiProperty } from '@nestjs/swagger';
import { VideoProcessingStatus, VideoPublicationStatus } from '../video.enums';

export class InitiateUploadResponseDto {
  /** 11-char public ID used in every /videos/:videoId route */
  videoId: string;

  /** S3 multipart UploadId */
  uploadId: string;

  /** Server-dictated part size in bytes */
  partSize: number;

  /** Number of parts the client must upload: ceil(size / partSize) */
  partCount: number;

  @ApiProperty({
    enum: VideoProcessingStatus,
    example: VideoProcessingStatus.UPLOADING,
  })
  processingStatus: VideoProcessingStatus;

  @ApiProperty({
    enum: VideoPublicationStatus,
    example: VideoPublicationStatus.DRAFT,
  })
  publicationStatus: VideoPublicationStatus;
}
