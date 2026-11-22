import { createParser, type EventSourceMessage } from 'eventsource-parser';

export type SseFrame = Pick<EventSourceMessage, 'data' | 'event'>;
export const DEFAULT_SSE_FRAME_OVERHEAD_BYTES = 64 * 1024;

// Enforce the raw byte budget before the parser can accumulate a partial line.
// CR, LF and CRLF each end one SSE line, including across network chunks.
export function createBoundedSseDecoder(
  maxFrameBytes: number,
): TransformStream<Uint8Array, SseFrame> {
  const decoder = new TextDecoder();
  let frameBytes = 0;
  let emptyLine = true;
  let afterCR = false;
  let parser: ReturnType<typeof createParser>;

  return new TransformStream({
    start(output) {
      parser = createParser({ onEvent: (event) => output.enqueue(event) });
    },
    transform(chunk) {
      for (const byte of chunk) {
        if (afterCR && byte === 10) {
          afterCR = false;
          if (frameBytes !== 0 && ++frameBytes > maxFrameBytes)
            throw new Error('sse frame too large');
          continue;
        }
        afterCR = byte === 13;
        if (++frameBytes > maxFrameBytes) throw new Error('sse frame too large');
        if (afterCR || byte === 10) {
          if (emptyLine) frameBytes = 0;
          emptyLine = true;
        } else {
          emptyLine = false;
        }
      }
      parser.feed(decoder.decode(chunk, { stream: true }));
    },
    flush() {
      parser.feed(decoder.decode());
    },
  });
}
