export class SignedPartDto {
  partNumber: number;

  /** Presigned PUT URL for this part */
  url: string;
}

export class SignedPartsResponseDto {
  /** One presigned URL per requested part */
  parts: SignedPartDto[];

  /** Lifetime of every URL in this response, in seconds */
  expiresInSeconds: number;
}
