/**
 * Pure UTF-8 terminal output ring buffer: truncates from the start at valid
 * UTF-8 character boundaries without depending on Node-specific APIs.
 */

const utf8Encoder = new TextEncoder()

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength
}

export function truncateOutputFromStart(
  text: string,
  byteLimit: number,
): { text: string; truncated: boolean } {
  if (byteLimit <= 0) return { text: '', truncated: text.length > 0 }
  if (utf8ByteLength(text) <= byteLimit) {
    return { text, truncated: false }
  }

  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (utf8ByteLength(text.slice(mid)) <= byteLimit) hi = mid
    else lo = mid + 1
  }
  return { text: text.slice(lo), truncated: true }
}

export function appendTerminalOutput(
  current: string,
  chunk: string,
  byteLimit: number,
): { output: string; truncated: boolean } {
  const { text, truncated } = truncateOutputFromStart(current + chunk, byteLimit)
  return { output: text, truncated }
}
