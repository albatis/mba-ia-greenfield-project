import { PUBLIC_ID_LENGTH, generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('returns 11 characters from the base64url alphabet', () => {
    const id = generatePublicId();

    expect(id).toHaveLength(PUBLIC_ID_LENGTH);
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('does not repeat across a sample of 10,000 IDs', () => {
    const ids = new Set(Array.from({ length: 10_000 }, generatePublicId));

    expect(ids.size).toBe(10_000);
  });
});
