export interface OutputBuffer {
  chunks: Uint8Array[];
  start: number;
  bytes: number;
  /** A transport gap requires a fresh terminal replay, even if chunk positions match. */
  gaps?: number;
}

export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_CHUNKS = 4096;

export function appendOutput(previous: OutputBuffer | undefined, data: Uint8Array): OutputBuffer {
  const chunks = [...(previous?.chunks ?? []), data];
  let bytes = (previous?.bytes ?? 0) + data.byteLength;
  let removed = 0;
  while (removed < chunks.length && (bytes > MAX_OUTPUT_BYTES || chunks.length - removed > MAX_OUTPUT_CHUNKS)) {
    bytes -= chunks[removed++].byteLength;
  }
  return { chunks: chunks.slice(removed), start: (previous?.start ?? 0) + removed, bytes, gaps: previous?.gaps ?? 0 };
}

export function trimOutput(buffer: OutputBuffer, budget: number): OutputBuffer {
  let bytes = buffer.bytes;
  let removed = 0;
  while (bytes > budget && removed < buffer.chunks.length) bytes -= buffer.chunks[removed++].byteLength;
  return removed ? { ...buffer, chunks: buffer.chunks.slice(removed), bytes, start: buffer.start + removed } : buffer;
}
