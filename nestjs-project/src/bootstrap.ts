import type { IncomingMessage, ServerResponse } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import express from 'express';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from './common/filters/validation-exception.filter';
import { TUS_PATH, TUS_SERVER } from './uploads/uploads.constants';

interface TusServer {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/**
 * Every global the application needs, in the order it needs them.
 *
 * Shared with the E2E suite on purpose: `Test.createTestingModule()` does not
 * execute `main.ts`, so without this the tests would run against a differently
 * configured app than production — and the body-parser ordering below is
 * exactly the kind of thing that has to be identical in both.
 *
 * The app must be created with `{ bodyParser: false }`.
 */
export function configureApp(app: INestApplication): void {
  // First: raw Express middleware, so the tus endpoint sees the unconsumed
  // chunk stream. It is therefore outside the global JwtAuthGuard and the
  // domain exception filter, and authenticates with its own upload ticket.
  const tusServer = app.get<TusServer>(TUS_SERVER);
  app.use(TUS_PATH, (req: IncomingMessage, res: ServerResponse) => {
    void tusServer.handle(req, res);
  });

  // Only then the parsers, so every other route keeps its parsed body.
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
}
