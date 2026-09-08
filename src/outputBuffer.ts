export interface OutputBuffer {
  chunks: Uint8Array[];
  start: number;
  bytes: number;
}

export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHUNKS = 4096;

export function appendOutput(previous: OutputBuffer | undefined, data: Uint8Array): OutputBuffer {
  const chunks = [...(previous?.chunks ?? []), data];
  let bytes = (previous?.bytes ?? 0) + data.byteLength;
  let removed = 0;
  while (removed < chunks.length && (bytes > MAX_OUTPUT_BYTES || chunks.length - removed > MAX_OUTPUT_CHUNKS)) {
    bytes -= chunks[removed++].byteLength;
  }
  return { chunks: chunks.slice(removed), start: (previous?.start ?? 0) + removed, bytes };
}
