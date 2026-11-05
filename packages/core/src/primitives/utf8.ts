/**
 * UTF-8 byte length of a string, as `TextEncoder` would encode it, without
 * allocating the encoded bytes. Lone surrogates count as U+FFFD (3 bytes),
 * matching the encoder's replacement.
 * @param text - the string to measure.
 * @returns the number of bytes its UTF-8 encoding occupies.
 */
export function utf8ByteLength(text: string): number {
  let bytes = text.length
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) continue
    if (code < 0x800) {
      bytes += 1
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Two UTF-16 units → four bytes.
        bytes += 2
        index++
        continue
      }
    }
    bytes += 2
  }
  return bytes
}
