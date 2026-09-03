import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { StorageService } from '../storage/storage.service';
import { QueueService } from '../queue/queue.service';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { UploadTicketService } from './upload-ticket.service';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with its TypeORM, Channels, Storage, Queue and Jwt wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            authConfig,
            databaseConfig,
            queueConfig,
            storageConfig,
            uploadConfig,
          ],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    expect(module.get(UploadTicketService)).toBeInstanceOf(UploadTicketService);
    // Reachable through VideosModule's own imports, not the root injector.
    expect(module.select(VideosModule).get(StorageService)).toBeInstanceOf(
      StorageService,
    );
    expect(module.select(VideosModule).get(QueueService)).toBeInstanceOf(
      QueueService,
    );

    await module.close();
  }, 60000);
});
