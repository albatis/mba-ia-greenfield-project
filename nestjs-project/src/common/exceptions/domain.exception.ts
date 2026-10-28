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

export class FileTooLargeException extends DomainException {
  constructor() {
    super('FILE_TOO_LARGE', 400, 'File exceeds the maximum upload size');
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_VIDEO_TYPE', 400, 'Video type is not supported');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class UploadNotInProgressException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_IN_PROGRESS', 409, 'Video upload is not in progress');
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super(
      'INVALID_PART_NUMBER',
      400,
      'Part number is greater than the part count',
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super('INVALID_UPLOAD_PARTS', 400, 'Upload parts are invalid');
  }
}
