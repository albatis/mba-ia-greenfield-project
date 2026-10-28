import { Module } from '@nestjs/common';
import { FfmpegService } from './ffmpeg.service';
import { FfprobeService } from './ffprobe.service';

@Module({
  providers: [FfprobeService, FfmpegService],
  exports: [FfprobeService, FfmpegService],
})
export class MediaModule {}
