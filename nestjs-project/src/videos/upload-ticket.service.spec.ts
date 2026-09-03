import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { InvalidUploadTicketException } from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import {
  UPLOAD_TICKET_SCOPE,
  UploadTicketService,
  type UploadTicketPayload,
} from './upload-ticket.service';

const TEST_SECRET = 'upload-ticket-test-secret';

describe('UploadTicketService', () => {
  let service: UploadTicketService;
  let jwtService: JwtService;

  beforeAll(async () => {
    // A real JwtModule, never a mocked JwtService: mocking `sign` would hide a
    // wrong secret, a wrong expiry, or a malformed payload — the exact bugs
    // this service can have.
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_SECRET })],
      providers: [
        UploadTicketService,
        {
          provide: uploadConfig.KEY,
          useValue: { ticketExpirationHours: 2 },
        },
      ],
    }).compile();

    service = module.get(UploadTicketService);
    jwtService = module.get(JwtService);
  });

  describe('issue', () => {
    it('should sign a JWT carrying sub, the upload scope, and a jti', () => {
      const { ticket } = service.issue('user-1');

      const decoded = jwtService.verify<UploadTicketPayload>(ticket);
      expect(decoded.sub).toBe('user-1');
      expect(decoded.scope).toBe(UPLOAD_TICKET_SCOPE);
      expect(decoded.jti).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('should give every ticket a distinct jti', () => {
      const first = jwtService.verify<UploadTicketPayload>(
        service.issue('user-1').ticket,
      );
      const second = jwtService.verify<UploadTicketPayload>(
        service.issue('user-1').ticket,
      );

      expect(second.jti).not.toBe(first.jti);
    });

    it('should expire the ticket after the configured hours', () => {
      const { ticket, expiresAt } = service.issue('user-1');

      const decoded = jwtService.verify<{ exp: number; iat: number }>(ticket);
      expect(decoded.exp - decoded.iat).toBe(2 * 60 * 60);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('verify', () => {
    it('should accept a ticket it issued', () => {
      const { ticket } = service.issue('user-1');

      expect(service.verify(ticket).sub).toBe('user-1');
    });

    it('should reject a missing ticket', () => {
      expect(() => service.verify(undefined)).toThrow(
        InvalidUploadTicketException,
      );
    });

    it('should reject an expired ticket', () => {
      const expired = jwtService.sign(
        { sub: 'user-1', scope: UPLOAD_TICKET_SCOPE, jti: 'j' },
        { expiresIn: '-1s' },
      );

      expect(() => service.verify(expired)).toThrow(
        InvalidUploadTicketException,
      );
    });

    it('should reject a tampered signature', () => {
      const { ticket } = service.issue('user-1');
      const tampered = `${ticket.slice(0, -3)}xyz`;

      expect(() => service.verify(tampered)).toThrow(
        InvalidUploadTicketException,
      );
    });

    it('should reject a token signed with a different secret', () => {
      const foreign = new JwtService({ secret: 'some-other-secret' }).sign({
        sub: 'user-1',
        scope: UPLOAD_TICKET_SCOPE,
        jti: 'j',
      });

      expect(() => service.verify(foreign)).toThrow(
        InvalidUploadTicketException,
      );
    });

    it('should reject a valid access token that lacks the upload scope', () => {
      // Shape of a Phase 02 access token: same secret, no `scope` claim.
      const accessToken = jwtService.sign({
        sub: 'user-1',
        email: 'user@example.com',
      });

      expect(() => service.verify(accessToken)).toThrow(
        InvalidUploadTicketException,
      );
    });

    it('should reject a token whose scope is something else', () => {
      const wrongScope = jwtService.sign({
        sub: 'user-1',
        scope: 'refresh',
        jti: 'j',
      });

      expect(() => service.verify(wrongScope)).toThrow(
        InvalidUploadTicketException,
      );
    });
  });

  describe('extractBearer', () => {
    it('should pull the token out of a Bearer header', () => {
      expect(service.extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    });

    it('should be case-insensitive on the scheme', () => {
      expect(service.extractBearer('bearer abc')).toBe('abc');
    });

    it('should return null for a missing or non-Bearer header', () => {
      expect(service.extractBearer(undefined)).toBeNull();
      expect(service.extractBearer('Basic abc')).toBeNull();
      expect(service.extractBearer('Bearer')).toBeNull();
    });
  });
});
