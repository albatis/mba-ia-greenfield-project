import { randomBytes, randomUUID } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import type { TestingModule } from '@nestjs/testing';
import {
  TEST_VIDEOS_BUCKET,
  buildTestStorageConfig,
  clearTestBuckets,
  createTestStorage,
} from '../test/storage';
import { applyBucketCors } from './scripts/apply-bucket-cors';
import { STORAGE_BUCKETS } from './storage.constants';
import { StoragePartsRejectedError } from './storage.errors';
import type { StorageService } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;
const FRONTEND_ORIGIN = 'http://localhost:3001';
const videos = STORAGE_BUCKETS.VIDEOS;

const newKey = (): string => `videos/${randomUUID()}/source`;

async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  expect(res.status).toBe(200);
  const etag = res.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag!;
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;

  beforeAll(async () => {
    ({ module, storage } = await createTestStorage());
  });

  beforeEach(async () => {
    await clearTestBuckets();
  });

  afterAll(async () => {
    await clearTestBuckets();
    await module.close();
  });

  describe('multipart upload', () => {
    it('should assemble parts PUT through presigned URLs into one object', async () => {
      const key = newKey();
      const parts = [randomBytes(MIN_PART_SIZE), randomBytes(1024)];
      const uploadId = await storage.createMultipartUpload({
        bucket: videos,
        key,
        contentType: 'video/mp4',
      });

      const etags: string[] = [];
      for (const [index, body] of parts.entries()) {
        const url = await storage.presignUploadPart({
          bucket: videos,
          key,
          uploadId,
          partNumber: index + 1,
          expiresInSeconds: 60,
        });
        etags.push(await putPart(url, body));
      }

      const listed = await storage.listParts({ bucket: videos, key, uploadId });
      expect(listed).toEqual([
        { partNumber: 1, etag: etags[0], size: parts[0].length },
        { partNumber: 2, etag: etags[1], size: parts[1].length },
      ]);

      await storage.completeMultipartUpload({
        bucket: videos,
        key,
        uploadId,
        parts: listed.map(({ partNumber, etag }) => ({ partNumber, etag })),
      });

      const head = await storage.headObject({ bucket: videos, key });
      expect(head).toEqual({
        contentLength: parts[0].length + parts[1].length,
        contentType: 'video/mp4',
      });
    });

    it('should return an empty part list for a freshly created upload', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload({
        bucket: videos,
        key,
        contentType: 'video/webm',
      });

      await expect(
        storage.listParts({ bucket: videos, key, uploadId }),
      ).resolves.toEqual([]);
    });

    it('should raise StoragePartsRejectedError when storage rejects the part list', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload({
        bucket: videos,
        key,
        contentType: 'video/mp4',
      });
      const url = await storage.presignUploadPart({
        bucket: videos,
        key,
        uploadId,
        partNumber: 1,
        expiresInSeconds: 60,
      });
      await putPart(url, randomBytes(1024));

      const completion = storage.completeMultipartUpload({
        bucket: videos,
        key,
        uploadId,
        parts: [{ partNumber: 1, etag: '"0123456789abcdef0123456789abcdef"' }],
      });

      await expect(completion).rejects.toBeInstanceOf(
        StoragePartsRejectedError,
      );
      await expect(completion).rejects.toMatchObject({ reason: 'InvalidPart' });
    });

    it('should abort an upload so it can no longer be listed', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload({
        bucket: videos,
        key,
        contentType: 'video/mp4',
      });

      await storage.abortMultipartUpload({ bucket: videos, key, uploadId });

      await expect(
        storage.listParts({ bucket: videos, key, uploadId }),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });

    it('should treat aborting a nonexistent upload as a no-op', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload({
        bucket: videos,
        key,
        contentType: 'video/mp4',
      });
      await storage.abortMultipartUpload({ bucket: videos, key, uploadId });

      await expect(
        storage.abortMultipartUpload({ bucket: videos, key, uploadId }),
      ).resolves.toBeUndefined();
    });

    it('should answer the frontend CORS preflight on part URLs exposing ETag', async () => {
      await applyBucketCors([TEST_VIDEOS_BUCKET]);
      const key = newKey();
      const uploadId = await storage.createMultipartUpload({
        bucket: videos,
        key,
        contentType: 'video/mp4',
      });
      const url = await storage.presignUploadPart({
        bucket: videos,
        key,
        uploadId,
        partNumber: 1,
        expiresInSeconds: 60,
      });

      const res = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: FRONTEND_ORIGIN,
          'Access-Control-Request-Method': 'PUT',
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(
        FRONTEND_ORIGIN,
      );
      expect(
        res.headers.get('access-control-expose-headers')?.toLowerCase(),
      ).toContain('etag');
    });
  });

  describe('objects', () => {
    it('should return null from headObject when the object does not exist', async () => {
      await expect(
        storage.headObject({ bucket: videos, key: newKey() }),
      ).resolves.toBeNull();
    });

    it('should delete an object', async () => {
      const key = newKey();
      await storage.putObject({
        bucket: videos,
        key,
        body: 'payload',
        contentType: 'text/plain',
      });

      await storage.deleteObject({ bucket: videos, key });

      await expect(
        storage.headObject({ bucket: videos, key }),
      ).resolves.toBeNull();
    });

    it('should upload a stream and download it back to a file', async () => {
      const key = `thumbnails/${randomUUID()}.jpg`;
      const content = randomBytes(64 * 1024);
      await storage.uploadStream({
        bucket: STORAGE_BUCKETS.THUMBNAILS,
        key,
        body: Readable.from(content),
        contentType: 'image/jpeg',
      });
      const dir = await mkdtemp(join(tmpdir(), 'storage-spec-'));
      const filePath = join(dir, 'download.jpg');

      try {
        await storage.downloadToFile({
          bucket: STORAGE_BUCKETS.THUMBNAILS,
          key,
          filePath,
        });

        expect((await readFile(filePath)).equals(content)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('presignGetObject', () => {
    const content = randomBytes(1000);
    let key: string;

    beforeEach(async () => {
      key = newKey();
      await storage.putObject({
        bucket: videos,
        key,
        body: content,
        contentType: 'video/mp4',
      });
    });

    it('should serve byte ranges with 206 Partial Content', async () => {
      const url = await storage.presignGetObject({
        bucket: videos,
        key,
        expiresInSeconds: 60,
        disposition: 'inline',
        contentType: 'video/mp4',
      });

      const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });
      const body = Buffer.from(await res.arrayBuffer());

      expect(res.status).toBe(206);
      expect(body.length).toBe(100);
      expect(body.equals(content.subarray(0, 100))).toBe(true);
    });

    it('should reflect the requested disposition and content type in the response', async () => {
      const disposition = 'attachment; filename="my video.mp4"';
      const url = await storage.presignGetObject({
        bucket: videos,
        key,
        expiresInSeconds: 60,
        disposition,
        contentType: 'video/mp4',
      });

      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(disposition);
      expect(res.headers.get('content-type')).toBe('video/mp4');
    });

    it('should sign GET URLs for the configured presign host', async () => {
      const url = await storage.presignGetObject({
        bucket: videos,
        key,
        expiresInSeconds: 60,
        disposition: 'inline',
        contentType: 'video/mp4',
      });

      expect(new URL(url).origin).toBe(
        new URL(buildTestStorageConfig().publicEndpoint).origin,
      );
    });
  });
});
