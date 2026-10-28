import { randomBytes } from 'crypto';

export const PUBLIC_ID_LENGTH = 11;

// 9 random bytes encode to 12 base64url chars; keeping 11 leaves 66 bits of
// entropy — unguessable and short enough for a URL.
export function generatePublicId(): string {
  return randomBytes(9).toString('base64url').slice(0, PUBLIC_ID_LENGTH);
}
