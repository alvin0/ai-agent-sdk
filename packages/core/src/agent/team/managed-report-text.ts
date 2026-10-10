

/** Cut text to a byte budget without splitting a UTF-16 surrogate pair. */
export function prefixWithinBytes(text: string, maxBytes: number): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(new TextEncoder().encode(text).subarray(0, maxBytes),
    { stream: true })
}

/** Keep both the initial findings and final verdict; the marker is inside the byte cap. */
export function truncate(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maxBytes) return text
  const marker = '\n… (truncated; read full result) …\n'
  const markerBytes = new TextEncoder().encode(marker).byteLength
  if (maxBytes <= markerBytes) return prefixWithinBytes('(truncated)', maxBytes)
  const remaining = maxBytes - markerBytes
  const head = prefixWithinBytes(text, Math.ceil(remaining / 2))
  let tailStart = encoded.length - Math.floor(remaining / 2)
  while (tailStart < encoded.length && (encoded[tailStart]! & 0xc0) === 0x80) tailStart++
  const tail = new TextDecoder().decode(encoded.subarray(tailStart))
  return head + marker + tail
}
