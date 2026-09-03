import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    const seq = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${seq}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${seq}`,
        nickname: `vidchan${seq}`,
        user_id: user.id,
      }),
    );
  }

  const draft = (channel: Channel, overrides: Partial<Video> = {}) =>
    videoRepository.create({
      channel_id: channel.id,
      title: 'Holiday clip',
      original_filename: 'holiday.mp4',
      ...overrides,
    });

  it('should assign an 11-character public_id when none is set', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(draft(channel));

    expect(saved.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should reject two videos sharing a public_id', async () => {
    const channel = await createChannel();
    const first = await videoRepository.save(draft(channel));

    await expect(
      videoRepository.save(draft(channel, { public_id: first.public_id })),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('should reject two videos sharing an upload_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(draft(channel, { upload_id: 'abc123.mp4' }));

    await expect(
      videoRepository.save(draft(channel, { upload_id: 'abc123.mp4' })),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('should default status to draft without the caller setting it', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(draft(channel));

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(reloaded.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject a status outside the video_status enum', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id", "channel_id", "title", "original_filename", "status")
         VALUES ($1, $2, $3, $4, $5)`,
        ['aaaaaaaaaaa', channel.id, 'Bad status', 'x.mp4', 'transcoding'],
      ),
    ).rejects.toThrow(/invalid input value for enum/i);
  });

  it('should load the channel relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(draft(channel));

    const loaded = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });

    expect(loaded.channel.id).toBe(channel.id);
    expect(loaded.channel.nickname).toBe(channel.nickname);
  });

  it('should cascade-delete videos when their channel is deleted', async () => {
    const channel = await createChannel();
    await videoRepository.save(draft(channel));

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.countBy({ channel_id: channel.id })).toBe(0);
  });

  it('should round-trip a size_bytes above 2^31', async () => {
    const channel = await createChannel();
    const tenGiB = '10737418240';

    const saved = await videoRepository.save(
      draft(channel, { size_bytes: tenGiB }),
    );

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(reloaded.size_bytes).toBe(tenGiB);
    expect(Number(reloaded.size_bytes)).toBe(10_737_418_240);
  });
});
