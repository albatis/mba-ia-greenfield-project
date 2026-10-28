import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Job, Worker } from 'bullmq';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import queueConfig from '../../config/queue.config';
import { FfmpegService } from '../../media/ffmpeg.service';
import { FfprobeService, type ProbeResult } from '../../media/ffprobe.service';
import { MediaCommandError } from '../../media/media-command';
import { needsFaststart } from '../../media/mp4-atoms.util';
import type { ProcessVideoJobData } from '../../queue/queue.constants';
import { STORAGE_BUCKETS } from '../../storage/storage.constants';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../../videos/entities/video.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../../videos/video.enums';
import { VideoProcessingProcessor } from './video-processing.processor';

jest.mock('../../media/mp4-atoms.util', () => ({
  needsFaststart: jest.fn(),
}));

const VIDEO_ID = 'video-1';
const PUBLIC_ID = 'Ab3_dE-fGh1';
const SOURCE_KEY = 'videos/video-1/source';
const CONCURRENCY = 4;

const h264Probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  durationSeconds: 30,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoStream: { codecName: 'h264', width: 1280, height: 720 },
  audioStream: { codecName: 'aac' },
  ...overrides,
});

const processingVideo = (overrides: Partial<Video> = {}): Partial<Video> => ({
  id: VIDEO_ID,
  public_id: PUBLIC_ID,
  processing_status: VideoProcessingStatus.PROCESSING,
  mime_type: 'video/mp4',
  source_key: SOURCE_KEY,
  ...overrides,
});

const jobFor = (
  overrides: { attemptsMade?: number; attempts?: number } = {},
): Job<ProcessVideoJobData> =>
  ({
    data: { videoId: VIDEO_ID },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  }) as Job<ProcessVideoJobData>;

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  const videoRepository = { findOneBy: jest.fn(), update: jest.fn() };
  const storage = {
    downloadToFile: jest.fn(),
    uploadStream: jest.fn(),
    putObject: jest.fn(),
  };
  const ffprobe = { probe: jest.fn() };
  // Fakes write their output files, like the real binaries
  const ffmpeg = {
    extractThumbnail: jest.fn<Promise<void>, [string, string, number]>(
      (_input, output) => writeFile(output, 'jpeg'),
    ),
    remuxFaststart: jest.fn((_input: string, output: string) =>
      writeFile(output, 'remuxed'),
    ),
  };
  const needsFaststartMock = jest.mocked(needsFaststart);

  /** Temp work dir used by the last process() call, taken from the download path */
  const lastWorkDir = (): string => {
    const [[{ filePath }]] = storage.downloadToFile.mock.calls as [
      [{ filePath: string }],
    ];
    return dirname(filePath);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    videoRepository.findOneBy.mockResolvedValue(processingVideo());
    ffprobe.probe.mockResolvedValue(h264Probe());
    needsFaststartMock.mockResolvedValue(false);

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storage },
        { provide: FfprobeService, useValue: ffprobe },
        { provide: FfmpegService, useValue: ffmpeg },
        {
          provide: queueConfig.KEY,
          useValue: { videoWorkerConcurrency: CONCURRENCY },
        },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
  });

  describe('onApplicationBootstrap', () => {
    it('applies VIDEO_WORKER_CONCURRENCY to the BullMQ worker', () => {
      const worker = { concurrency: 1 };
      jest
        .spyOn(processor, 'worker', 'get')
        .mockReturnValue(worker as unknown as Worker);

      processor.onApplicationBootstrap();

      expect(worker.concurrency).toBe(CONCURRENCY);
    });
  });

  describe('process', () => {
    it.each([
      ['not found', null],
      [
        'ready',
        processingVideo({ processing_status: VideoProcessingStatus.READY }),
      ],
      [
        'failed',
        processingVideo({ processing_status: VideoProcessingStatus.FAILED }),
      ],
    ])('exits without effects when the video is %s', async (_label, video) => {
      videoRepository.findOneBy.mockResolvedValue(video);

      await processor.process(jobFor());

      expect(videoRepository.findOneBy).toHaveBeenCalledWith({ id: VIDEO_ID });
      expect(storage.downloadToFile).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('stores the thumbnail and marks the video ready with its metadata', async () => {
      await processor.process(jobFor());

      expect(storage.downloadToFile).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: STORAGE_BUCKETS.VIDEOS,
          key: SOURCE_KEY,
        }),
      );
      expect(storage.putObject).toHaveBeenCalledWith({
        bucket: STORAGE_BUCKETS.THUMBNAILS,
        key: `${PUBLIC_ID}.jpg`,
        body: Buffer.from('jpeg'),
        contentType: 'image/jpeg',
      });
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, processing_status: VideoProcessingStatus.PROCESSING },
        {
          duration_seconds: 30,
          width: 1280,
          height: 720,
          video_codec: 'h264',
          audio_codec: 'aac',
          thumbnail_key: `${PUBLIC_ID}.jpg`,
          processing_status: VideoProcessingStatus.READY,
          processed_at: expect.any(Date) as Date,
        },
      );
    });

    it.each([
      [30, 1],
      [4, 0.4],
      [null, 0],
    ])(
      'takes the thumbnail frame at min(1s, 10%%) of a %ss video',
      async (durationSeconds, expectedAt) => {
        ffprobe.probe.mockResolvedValue(h264Probe({ durationSeconds }));

        await processor.process(jobFor());

        const [, , atSeconds] = ffmpeg.extractThumbnail.mock.calls[0];
        expect(atSeconds).toBeCloseTo(expectedAt);
      },
    );

    it('stores a null audio codec for a video without audio', async () => {
      ffprobe.probe.mockResolvedValue(h264Probe({ audioStream: null }));

      await processor.process(jobFor());

      expect(videoRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          audio_codec: null,
          processing_status: VideoProcessingStatus.READY,
        }),
      );
    });

    it('remuxes an MP4 with moov after mdat and overwrites the source object', async () => {
      needsFaststartMock.mockResolvedValue(true);

      await processor.process(jobFor());

      expect(ffmpeg.remuxFaststart).toHaveBeenCalledTimes(1);
      expect(storage.uploadStream).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: STORAGE_BUCKETS.VIDEOS,
          key: SOURCE_KEY,
          contentType: 'video/mp4',
        }),
      );
    });

    it('does not remux an MP4 that is already faststart', async () => {
      await processor.process(jobFor());

      expect(ffmpeg.remuxFaststart).not.toHaveBeenCalled();
      expect(storage.uploadStream).not.toHaveBeenCalled();
    });

    it('never checks faststart for a WebM video', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        processingVideo({ mime_type: 'video/webm' }),
      );
      ffprobe.probe.mockResolvedValue(
        h264Probe({
          formatName: 'matroska,webm',
          videoStream: { codecName: 'vp9', width: 640, height: 360 },
          audioStream: { codecName: 'opus' },
        }),
      );

      await processor.process(jobFor());

      expect(needsFaststartMock).not.toHaveBeenCalled();
      expect(ffmpeg.remuxFaststart).not.toHaveBeenCalled();
      expect(videoRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          processing_status: VideoProcessingStatus.READY,
        }),
      );
    });

    it('marks the video PROBE_FAILED without rethrowing when ffprobe fails', async () => {
      ffprobe.probe.mockRejectedValue(
        new MediaCommandError('ffprobe', 'exited with code 1', 'Invalid data'),
      );

      await expect(processor.process(jobFor())).resolves.toBeUndefined();

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: VideoFailureReason.PROBE_FAILED,
          processed_at: expect.any(Date) as Date,
        },
      );
      expect(ffmpeg.extractThumbnail).not.toHaveBeenCalled();
    });

    it('rethrows a probe error that is not a media command failure', async () => {
      const error = new Error('EMFILE: too many open files');
      ffprobe.probe.mockRejectedValue(error);

      await expect(processor.process(jobFor())).rejects.toBe(error);

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it.each([
      [
        'HEVC video',
        h264Probe({
          videoStream: { codecName: 'hevc', width: 640, height: 360 },
        }),
      ],
      ['MP3 audio', h264Probe({ audioStream: { codecName: 'mp3' } })],
      [
        'a WebM container declared as MP4',
        h264Probe({ formatName: 'matroska,webm' }),
      ],
    ])(
      'marks the video UNSUPPORTED_CODEC without rethrowing for %s',
      async (_label, probe) => {
        ffprobe.probe.mockResolvedValue(probe);

        await expect(processor.process(jobFor())).resolves.toBeUndefined();

        expect(videoRepository.update).toHaveBeenCalledWith(
          { id: VIDEO_ID, processing_status: VideoProcessingStatus.PROCESSING },
          {
            processing_status: VideoProcessingStatus.FAILED,
            failure_reason: VideoFailureReason.UNSUPPORTED_CODEC,
            processed_at: expect.any(Date) as Date,
          },
        );
        expect(ffmpeg.remuxFaststart).not.toHaveBeenCalled();
        expect(storage.putObject).not.toHaveBeenCalled();
      },
    );

    it('removes the temporary directory after a successful run', async () => {
      await processor.process(jobFor());

      expect(existsSync(lastWorkDir())).toBe(false);
    });

    it('rethrows a failing step for a retry and still removes the temporary directory', async () => {
      const error = new Error('storage unavailable');
      storage.putObject.mockRejectedValueOnce(error);

      await expect(processor.process(jobFor())).rejects.toBe(error);

      expect(existsSync(lastWorkDir())).toBe(false);
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('marks the video PROCESSING_ERROR after the last attempt', async () => {
      await processor.onFailed(
        jobFor({ attemptsMade: 3, attempts: 3 }),
        new Error('boom'),
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: VideoFailureReason.PROCESSING_ERROR,
          processed_at: expect.any(Date) as Date,
        },
      );
    });

    it('leaves the status untouched after an intermediate attempt', async () => {
      await processor.onFailed(
        jobFor({ attemptsMade: 1, attempts: 3 }),
        new Error('boom'),
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('ignores a failed event without a job', async () => {
      await processor.onFailed(undefined, new Error('boom'));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('does not reject when marking the video failed errors', async () => {
      videoRepository.update.mockRejectedValueOnce(new Error('db down'));

      await expect(
        processor.onFailed(
          jobFor({ attemptsMade: 3, attempts: 3 }),
          new Error('boom'),
        ),
      ).resolves.toBeUndefined();
    });
  });
});
