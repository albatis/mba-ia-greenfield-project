import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { FfmpegService } from '../../media/ffmpeg.service';
import { FfprobeService, type ProbeResult } from '../../media/ffprobe.service';
import { MediaCommandError } from '../../media/media-command';
import { needsFaststart } from '../../media/mp4-atoms.util';
import {
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import { STORAGE_BUCKETS } from '../../storage/storage.constants';
import {
  type ObjectLocation,
  StorageService,
} from '../../storage/storage.service';
import { Video } from '../../videos/entities/video.entity';
import { isPlayableCodec } from '../../videos/video-codec-allowlist';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../../videos/video.enums';

// Thumbnail frame at min(1s, 10% of the duration) so short clips still get a frame
const THUMBNAIL_MAX_OFFSET_SECONDS = 1;
const THUMBNAIL_DURATION_RATIO = 0.1;
const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';
const MP4_MIME_TYPE = 'video/mp4';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffprobe: FfprobeService,
    private readonly ffmpeg: FfmpegService,
    @Inject(queueConfig.KEY)
    private readonly queue: ConfigType<typeof queueConfig>,
  ) {
    super();
  }

  // @Processor options are static; the worker exists once onModuleInit has run
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.queue.videoWorkerConcurrency;
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    // Idempotency: a redelivered job for a ready/failed video is a no-op
    if (video?.processing_status !== VideoProcessingStatus.PROCESSING) {
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), 'video-processing-'));
    try {
      await this.processSource(video, workDir);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Runs on every failed attempt; only the last one marks the video failed */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) {
      return;
    }
    this.logger.error(
      `Video ${job.data.videoId} failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
    // Event handler: rethrowing would surface as an unhandled rejection
    try {
      await this.markFailed(
        job.data.videoId,
        VideoFailureReason.PROCESSING_ERROR,
      );
    } catch (markError) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed`,
        markError instanceof Error ? markError.stack : String(markError),
      );
    }
  }

  private async processSource(video: Video, workDir: string): Promise<void> {
    const source: ObjectLocation = {
      bucket: STORAGE_BUCKETS.VIDEOS,
      key: video.source_key,
    };
    const sourcePath = join(workDir, 'source');
    await this.storage.downloadToFile({ ...source, filePath: sourcePath });

    const probe = await this.probe(video, sourcePath);
    if (!probe) {
      return;
    }
    if (!isPlayableCodec(video.mime_type, probe)) {
      await this.markFailed(video.id, VideoFailureReason.UNSUPPORTED_CODEC);
      return;
    }

    if (
      video.mime_type === MP4_MIME_TYPE &&
      (await needsFaststart(sourcePath))
    ) {
      // Overwrites the source in place so playback can start before the full download
      const remuxedPath = join(workDir, 'faststart.mp4');
      await this.ffmpeg.remuxFaststart(sourcePath, remuxedPath);
      await this.storage.uploadStream({
        ...source,
        body: createReadStream(remuxedPath),
        contentType: video.mime_type,
      });
    }

    const thumbnailKey = await this.uploadThumbnail(
      video,
      sourcePath,
      join(workDir, 'thumbnail.jpg'),
      probe.durationSeconds,
    );

    await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.PROCESSING },
      {
        duration_seconds: probe.durationSeconds,
        width: probe.videoStream.width,
        height: probe.videoStream.height,
        video_codec: probe.videoStream.codecName,
        audio_codec: probe.audioStream?.codecName ?? null,
        thumbnail_key: thumbnailKey,
        processing_status: VideoProcessingStatus.READY,
        processed_at: new Date(),
      },
    );
  }

  /** null when the file is not probeable: the video is marked failed, not retried */
  private async probe(
    video: Video,
    sourcePath: string,
  ): Promise<ProbeResult | null> {
    try {
      return await this.ffprobe.probe(sourcePath);
    } catch (error) {
      if (!(error instanceof MediaCommandError)) {
        throw error;
      }
      this.logger.warn(`Video ${video.id} is not probeable: ${error.message}`);
      await this.markFailed(video.id, VideoFailureReason.PROBE_FAILED);
      return null;
    }
  }

  private async uploadThumbnail(
    video: Video,
    sourcePath: string,
    thumbnailPath: string,
    durationSeconds: number | null,
  ): Promise<string> {
    const atSeconds = Math.min(
      THUMBNAIL_MAX_OFFSET_SECONDS,
      (durationSeconds ?? 0) * THUMBNAIL_DURATION_RATIO,
    );
    await this.ffmpeg.extractThumbnail(sourcePath, thumbnailPath, atSeconds);

    // Deterministic key: a retried job overwrites the same object
    const key = `${video.public_id}.jpg`;
    await this.storage.putObject({
      bucket: STORAGE_BUCKETS.THUMBNAILS,
      key,
      body: await readFile(thumbnailPath),
      contentType: THUMBNAIL_CONTENT_TYPE,
    });
    return key;
  }

  private async markFailed(
    videoId: string,
    reason: VideoFailureReason,
  ): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, processing_status: VideoProcessingStatus.PROCESSING },
      {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: reason,
        processed_at: new Date(),
      },
    );
  }
}
