import type { Video } from './entities/video.entity';
import { toVideoResponse } from './video-response.mapper';
import {
  VideoFailureReason,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './video.enums';

const BASE_URL = 'http://thumbnails.example.test';

const buildVideo = (overrides: Partial<Video> = {}): Video =>
  ({
    id: '6f1c2a8e-0000-4000-8000-000000000001',
    public_id: 'Ab3_dE-fGh1',
    processing_status: VideoProcessingStatus.READY,
    publication_status: VideoPublicationStatus.DRAFT,
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: 7_340_032,
    duration_seconds: 12.5,
    width: 1280,
    height: 720,
    thumbnail_key: 'thumbnails/abc/thumb.jpg',
    failure_reason: null,
    created_at: new Date('2026-10-28T10:00:00.000Z'),
    ...overrides,
  }) as Video;

describe('toVideoResponse', () => {
  it('maps the entity to the camelCase contract keyed by the public ID', () => {
    expect(toVideoResponse(buildVideo(), BASE_URL)).toEqual({
      videoId: 'Ab3_dE-fGh1',
      processingStatus: 'ready',
      publicationStatus: 'draft',
      originalFilename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 7_340_032,
      durationSeconds: 12.5,
      width: 1280,
      height: 720,
      thumbnailUrl: `${BASE_URL}/thumbnails/abc/thumb.jpg`,
      failureReason: null,
      createdAt: '2026-10-28T10:00:00.000Z',
    });
  });

  it('returns a null thumbnailUrl while there is no thumbnail', () => {
    const response = toVideoResponse(
      buildVideo({
        processing_status: VideoProcessingStatus.FAILED,
        thumbnail_key: null,
        failure_reason: VideoFailureReason.PROBE_FAILED,
      }),
      BASE_URL,
    );

    expect(response.thumbnailUrl).toBeNull();
    expect(response.failureReason).toBe('PROBE_FAILED');
  });

  it('does not double the slash when the base URL ends with one', () => {
    const response = toVideoResponse(buildVideo(), `${BASE_URL}/`);

    expect(response.thumbnailUrl).toBe(`${BASE_URL}/thumbnails/abc/thumb.jpg`);
  });
});
