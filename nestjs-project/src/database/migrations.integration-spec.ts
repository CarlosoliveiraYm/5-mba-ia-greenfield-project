import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1788389829066 } from './migrations/1788389829066-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

/**
 * Enum types are schema objects owned by the migrations exactly like tables, so
 * resetting the schema has to drop them as well. Dropping only the tables leaves
 * the enum behind and the next run fails on `CREATE TYPE ... already exists`.
 *
 * Discovered from the catalog instead of hardcoded so a new enum in a future
 * migration stays covered without anyone remembering to update this file.
 * Restricted to `typtype = 'e'`, which leaves the `uuid-ossp` extension — also
 * living in `public`, but not created by any migration — untouched.
 */
async function dropManagedEnumTypes(dataSource: DataSource): Promise<void> {
  const enumTypes = await dataSource.query<{ typname: string }[]>(
    `SELECT t.typname
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typtype = 'e'`,
  );

  for (const { typname } of enumTypes) {
    await dataSource.query(`DROP TYPE IF EXISTS "public"."${typname}" CASCADE`);
  }
}

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1788389829066,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential, not `Promise.all`: concurrent `DROP TABLE ... CASCADE` on
    // tables joined by a foreign key (videos → channels → users) take their
    // locks in different orders and deadlock.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // After the tables are gone, so nothing still depends on the enums.
    await dropManagedEnumTypes(dataSource);
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'videos'`,
    );
    expect(result).toHaveLength(0);
  });
});
