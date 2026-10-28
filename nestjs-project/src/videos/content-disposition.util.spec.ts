import { buildContentDisposition } from './content-disposition.util';

describe('buildContentDisposition', () => {
  it('returns the bare type when there is no filename', () => {
    expect(buildContentDisposition('inline')).toBe('inline');
  });

  it('quotes a plain ASCII filename without filename*', () => {
    expect(buildContentDisposition('attachment', 'clip.mp4')).toBe(
      'attachment; filename="clip.mp4"',
    );
  });

  it('escapes quotes and backslashes in the quoted filename', () => {
    expect(buildContentDisposition('attachment', 'my "best"\\clip.mp4')).toBe(
      'attachment; filename="my \\"best\\"\\\\clip.mp4"',
    );
  });

  it('adds a UTF-8 filename* with an ASCII fallback for non-ASCII names', () => {
    expect(buildContentDisposition('attachment', "meu vídeo (1)'.mp4")).toBe(
      'attachment; filename="meu v_deo (1)\'.mp4"; ' +
        "filename*=UTF-8''meu%20v%C3%ADdeo%20%281%29%27.mp4",
    );
  });

  it('strips control characters and lone surrogates', () => {
    expect(
      buildContentDisposition('attachment', 'cl\r\nip\u0000\ud800.mp4'),
    ).toBe('attachment; filename="clip.mp4"');
  });

  it('falls back to the bare type when nothing survives sanitizing', () => {
    expect(buildContentDisposition('attachment', '\u0001\u0002')).toBe(
      'attachment',
    );
  });
});
