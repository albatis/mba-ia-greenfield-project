import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createWriteStream } from 'fs';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import storageConfig from '../config/storage.config';
import {
  S3_CLIENT,
  S3_PARTS_REJECTED_ERRORS,
  S3_PRESIGN_CLIENT,
  STORAGE_BUCKETS,
  type StorageBucket,
} from './storage.constants';
import { StoragePartsRejectedError } from './storage.errors';

export interface ObjectLocation {
  bucket: StorageBucket;
  key: string;
}

export interface MultipartLocation extends ObjectLocation {
  uploadId: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectMetadata {
  contentLength: number;
  contentType: string | undefined;
}

const isS3Error = (error: unknown, names: readonly string[]): boolean =>
  error instanceof S3ServiceException && names.includes(error.name);

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_PRESIGN_CLIENT) private readonly presignS3: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    location: ObjectLocation & { contentType: string },
  ): Promise<string> {
    const { UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName(location.bucket),
        Key: location.key,
        ContentType: location.contentType,
      }),
    );
    if (!UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return UploadId;
  }

  async presignUploadPart(
    location: MultipartLocation & {
      partNumber: number;
      expiresInSeconds: number;
    },
  ): Promise<string> {
    return getSignedUrl(
      this.presignS3,
      new UploadPartCommand({
        Bucket: this.bucketName(location.bucket),
        Key: location.key,
        UploadId: location.uploadId,
        PartNumber: location.partNumber,
      }),
      { expiresIn: location.expiresInSeconds },
    );
  }

  async listParts(location: MultipartLocation): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;

    do {
      const page = await this.s3.send(
        new ListPartsCommand({
          Bucket: this.bucketName(location.bucket),
          Key: location.key,
          UploadId: location.uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber!,
          etag: part.ETag!,
          size: part.Size ?? 0,
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    location: MultipartLocation & { parts: CompletedPart[] },
  ): Promise<void> {
    try {
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucketName(location.bucket),
          Key: location.key,
          UploadId: location.uploadId,
          MultipartUpload: {
            Parts: location.parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      if (isS3Error(error, S3_PARTS_REJECTED_ERRORS)) {
        const s3Error = error as S3ServiceException;
        throw new StoragePartsRejectedError(s3Error.name, s3Error.message);
      }
      throw error;
    }
  }

  async abortMultipartUpload(location: MultipartLocation): Promise<void> {
    try {
      await this.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucketName(location.bucket),
          Key: location.key,
          UploadId: location.uploadId,
        }),
      );
    } catch (error) {
      // Already aborted or completed — aborting is idempotent
      if (isS3Error(error, ['NoSuchUpload'])) {
        return;
      }
      throw error;
    }
  }

  async headObject(location: ObjectLocation): Promise<ObjectMetadata | null> {
    try {
      const head = await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.bucketName(location.bucket),
          Key: location.key,
        }),
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
      };
    } catch (error) {
      if (isS3Error(error, ['NotFound', 'NoSuchKey'])) {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(location: ObjectLocation): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName(location.bucket),
        Key: location.key,
      }),
    );
  }

  async putObject(
    location: ObjectLocation & { body: Buffer | string; contentType: string },
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName(location.bucket),
        Key: location.key,
        Body: location.body,
        ContentType: location.contentType,
      }),
    );
  }

  async uploadStream(
    location: ObjectLocation & { body: Readable; contentType: string },
  ): Promise<void> {
    await new Upload({
      client: this.s3,
      params: {
        Bucket: this.bucketName(location.bucket),
        Key: location.key,
        Body: location.body,
        ContentType: location.contentType,
      },
    }).done();
  }

  async downloadToFile(
    location: ObjectLocation & { filePath: string },
  ): Promise<void> {
    const { Body } = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucketName(location.bucket),
        Key: location.key,
      }),
    );
    if (!Body) {
      throw new Error(`Object ${location.key} has no body`);
    }
    await pipeline(Body as Readable, createWriteStream(location.filePath));
  }

  async presignGetObject(
    location: ObjectLocation & {
      expiresInSeconds: number;
      disposition: string;
      contentType: string;
    },
  ): Promise<string> {
    return getSignedUrl(
      this.presignS3,
      new GetObjectCommand({
        Bucket: this.bucketName(location.bucket),
        Key: location.key,
        ResponseContentDisposition: location.disposition,
        ResponseContentType: location.contentType,
      }),
      { expiresIn: location.expiresInSeconds },
    );
  }

  private bucketName(bucket: StorageBucket): string {
    return bucket === STORAGE_BUCKETS.VIDEOS
      ? this.config.videosBucket
      : this.config.thumbnailsBucket;
  }
}
