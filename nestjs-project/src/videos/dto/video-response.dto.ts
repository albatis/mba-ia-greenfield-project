import { ApiProperty } from '@nestjs/swagger';
import {
  VideoFailureReason,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from '../video.enums';

export class VideoResponseDto {
  /** 11-char public ID */
  videoId: string;

  @ApiProperty({ enum: VideoProcessingStatus })
  processingStatus: VideoProcessingStatus;

  @ApiProperty({ enum: VideoPublicationStatus })
  publicationStatus: VideoPublicationStatus;

  originalFilename: string;

  mimeType: string;

  sizeBytes: number;

  durationSeconds: number | null;

  width: number | null;

  height: number | null;

  /** Stable public thumbnail URL; null until the video is ready */
  thumbnailUrl: string | null;

  @ApiProperty({ enum: VideoFailureReason, nullable: true })
  failureReason: VideoFailureReason | null;

  /** ISO-8601 */
  createdAt: string;
}
