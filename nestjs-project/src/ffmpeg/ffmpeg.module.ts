import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FfmpegService } from './ffmpeg.service';

@Module({
  imports: [ConfigModule],
  providers: [FfmpegService],
  exports: [FfmpegService],
})
export class FfmpegModule {}
