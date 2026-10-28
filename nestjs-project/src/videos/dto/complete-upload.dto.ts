import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { COMPLETE_PARTS_MAX } from '../videos.constants';

export class CompletedPartDto {
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag returned by storage for the part PUT */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every uploaded part; partNumber must be unique and within 1..partCount */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(COMPLETE_PARTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
