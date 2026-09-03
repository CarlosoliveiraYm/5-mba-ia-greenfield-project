import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import uploadConfig from '../config/upload.config';
import { FfmpegModule } from './ffmpeg.module';
import { FfmpegService } from './ffmpeg.service';

describe('FfmpegModule', () => {
  it('should compile and export FfmpegService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [uploadConfig] }),
        FfmpegModule,
      ],
    }).compile();

    expect(module.get(FfmpegService)).toBeInstanceOf(FfmpegService);
    await module.close();
  });
});
