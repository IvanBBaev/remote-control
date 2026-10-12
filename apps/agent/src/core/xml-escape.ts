/** Characters XML 1.0 cannot carry at all, not even escaped (lone surrogates included). */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿\uD800-\uDFFF]/u;

/**
 * Escapes text for an XML element or attribute value (the launchd plist and the Windows
 * task definition share it). A character XML cannot represent throws `RangeError`.
 */
export function escapeXml(value: string): string {
  if (XML_INVALID.test(value)) {
    throw new RangeError('value contains a character XML cannot represent');
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
