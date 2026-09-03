import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { InvalidUploadTicketException } from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';

export const UPLOAD_TICKET_SCOPE = 'upload' as const;

export interface UploadTicketPayload {
  sub: string;
  scope: typeof UPLOAD_TICKET_SCOPE;
  jti: string;
}

export interface IssuedUploadTicket {
  ticket: string;
  expiresAt: Date;
}

/**
 * Mints the credential the browser presents to the tus endpoint.
 *
 * The 15-minute access token is far too short for a 10 GB transfer, and the
 * Strict BFF keeps the session out of the browser entirely — so uploads get
 * their own scoped, longer-lived token. The `scope` claim is what stops a plain
 * access token from being replayed against `/uploads`.
 */
@Injectable()
export class UploadTicketService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(uploadConfig.KEY)
    private readonly config: ConfigType<typeof uploadConfig>,
  ) {}

  issue(userId: string): IssuedUploadTicket {
    const expiresIn = `${this.config.ticketExpirationHours}h` as StringValue;
    const payload: UploadTicketPayload = {
      sub: userId,
      scope: UPLOAD_TICKET_SCOPE,
      jti: randomUUID(),
    };

    return {
      ticket: this.jwtService.sign(payload, { expiresIn }),
      expiresAt: new Date(
        Date.now() + this.config.ticketExpirationHours * 60 * 60 * 1000,
      ),
    };
  }

  /** Throws `InvalidUploadTicketException` for anything that is not a live ticket. */
  verify(rawTicket: string | undefined | null): UploadTicketPayload {
    if (!rawTicket) {
      throw new InvalidUploadTicketException();
    }

    let payload: UploadTicketPayload;
    try {
      payload = this.jwtService.verify<UploadTicketPayload>(rawTicket);
    } catch {
      throw new InvalidUploadTicketException();
    }

    if (payload.scope !== UPLOAD_TICKET_SCOPE || !payload.sub) {
      throw new InvalidUploadTicketException();
    }

    return payload;
  }

  /** Pulls the bearer value out of an `Authorization` header. */
  extractBearer(header: string | undefined): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
