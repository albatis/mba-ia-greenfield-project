export class MediaUrlResponseDto {
  /** Presigned GET URL served directly by storage */
  url: string;

  /** Lifetime of the URL, in seconds; request a new one once storage answers 403 */
  expiresInSeconds: number;
}
