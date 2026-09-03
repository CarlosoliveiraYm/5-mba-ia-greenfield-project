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
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { buildUploadId } from './tus-server.provider';
import { TusStoreModule } from './tus-store.module';
import { TUS_SERVER, TUS_STORE } from './uploads.constants';
import { UploadsModule } from './uploads.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const config = () =>
  ConfigModule.forRoot({
    isGlobal: true,
    load: [
      authConfig,
      databaseConfig,
      queueConfig,
      storageConfig,
      uploadConfig,
    ],
  });

describe('TusStoreModule', () => {
  it('should compile on its own, with no HTTP dependency in its graph', async () => {
    // This is the property the worker relies on: it imports the store for the
    // abandoned-upload sweep and must not pull in the tus Server.
    const module = await Test.createTestingModule({
      imports: [config(), TusStoreModule],
    }).compile();

    const store = module.get<{ deleteExpired: unknown; create: unknown }>(
      TUS_STORE,
    );
    expect(typeof store.deleteExpired).toBe('function');
    expect(typeof store.create).toBe('function');
    expect(() => {
      module.get(TUS_SERVER);
    }).toThrow();

    await module.close();
  }, 60000);
});

describe('UploadsModule', () => {
  it('should compile with TUS_STORE and TUS_SERVER resolving through the native-import factories', async () => {
    const module = await Test.createTestingModule({
      imports: [
        config(),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        UploadsModule,
      ],
    }).compile();

    const server = module.get<{ handle: unknown; options: { path: string } }>(
      TUS_SERVER,
    );
    expect(typeof server.handle).toBe('function');
    expect(server.options.path).toBe('/uploads');

    await module.close();
  }, 60000);
});

describe('buildUploadId', () => {
  it('should name the object <uuid>.<extension> from the declared filename', () => {
    const id = buildUploadId({
      filename: 'Holiday.MP4',
      filetype: 'video/mp4',
    });

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/,
    );
  });

  it('should never contain a slash, so the default id extraction keeps working', () => {
    const id = buildUploadId({ filename: 'nested/path/clip.webm' });

    expect(id).not.toContain('/');
    expect(id.endsWith('.webm')).toBe(true);
  });

  it('should fall back to .bin when no extension can be derived', () => {
    // Rejected later by onUploadCreate with a 415 — throwing here would be a 500.
    expect(buildUploadId({ filename: 'no-extension' })).toMatch(/\.bin$/);
    expect(buildUploadId(undefined)).toMatch(/\.bin$/);
  });

  it('should be unique across calls with identical metadata', () => {
    const metadata = { filename: 'clip.mp4' };

    expect(buildUploadId(metadata)).not.toBe(buildUploadId(metadata));
  });
});
