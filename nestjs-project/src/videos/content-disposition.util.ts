export type ContentDispositionType = 'inline' | 'attachment';

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
// With the `u` flag, valid surrogate pairs match as one code point, so only lone halves match
const LONE_SURROGATES = /\p{Surrogate}/gu;
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g;
const QUOTED_STRING_SPECIALS = /["\\]/g;
// RFC 5987 attr-char excludes these, but encodeURIComponent leaves them as-is
const RFC5987_RESERVED = /['()*]/g;

/**
 * RFC 6266 Content-Disposition value. Names with non-ASCII characters also
 * get an RFC 5987 `filename*` (UTF-8), with an ASCII `filename` fallback.
 */
export function buildContentDisposition(
  type: ContentDispositionType,
  filename?: string,
): string {
  const name = filename
    ?.replace(CONTROL_CHARS, '')
    .replace(LONE_SURROGATES, '');
  if (!name) {
    return type;
  }

  const ascii = name.replace(NON_PRINTABLE_ASCII, '_');
  const header = `${type}; filename="${ascii.replace(QUOTED_STRING_SPECIALS, '\\$&')}"`;
  if (ascii === name) {
    return header;
  }

  const encoded = encodeURIComponent(name).replace(
    RFC5987_RESERVED,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${header}; filename*=UTF-8''${encoded}`;
}
