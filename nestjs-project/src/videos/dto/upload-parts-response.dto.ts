export class UploadedPartDto {
  partNumber: number;

  /** ETag returned by storage for this part */
  etag: string;

  /** Part size in bytes */
  size: number;
}

export class UploadPartsResponseDto {
  /** S3 multipart UploadId */
  uploadId: string;

  /** Server-dictated part size in bytes */
  partSize: number;

  /** Number of parts the client must upload */
  partCount: number;

  /** Parts storage already holds, ordered by partNumber */
  uploadedParts: UploadedPartDto[];
}
