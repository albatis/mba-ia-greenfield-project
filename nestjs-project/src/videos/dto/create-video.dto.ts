import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class CreateVideoDto {
  /** Original filename, shown until the user sets a title */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** Declared file size in bytes; the 10GB ceiling answers FILE_TOO_LARGE */
  @IsInt()
  @Min(1)
  size: number;

  /** Declared MIME type; only video/mp4 and video/webm are accepted */
  @IsString()
  @IsNotEmpty()
  mimeType: string;
}
