export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class UploadAlreadyInProgressException extends DomainException {
  constructor() {
    super(
      'UPLOAD_ALREADY_IN_PROGRESS',
      409,
      'An upload is already in progress',
    );
  }
}

export class InvalidUploadTicketException extends DomainException {
  constructor() {
    super('INVALID_UPLOAD_TICKET', 401, 'Invalid or expired upload ticket');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}

/**
 * Raised by the worker's FFmpeg wrapper. Deliberately not in the HTTP error
 * catalog: the worker has no HTTP layer to map it to, and the job handler
 * translates it into a `failure_reason` on the video row.
 */
export class FfmpegCommandFailedException extends DomainException {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(
      'FFMPEG_COMMAND_FAILED',
      500,
      `${command} exited with ${exitCode ?? 'no code'}: ${stderrTail}`,
    );
  }
}

/** ffprobe returned unparsable JSON, or JSON with no usable video stream. */
export class ProbeFailedException extends DomainException {
  constructor(reason: string) {
    super('PROBE_FAILED', 500, `Could not probe the media file: ${reason}`);
  }
}
