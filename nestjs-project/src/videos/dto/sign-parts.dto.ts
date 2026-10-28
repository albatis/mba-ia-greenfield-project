import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { SIGN_PARTS_MAX } from '../videos.constants';

export class SignPartsDto {
  /** Part numbers to sign (1 to 100 unique integers, each within 1..partCount) */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SIGN_PARTS_MAX)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
