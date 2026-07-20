/**
 * A single Server-Sent Event parsed from an SSE stream.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
export interface SSEEvent {
  /** Concatenation of all `data:` lines (joined with `\n`). */
  data: string;
  /** Value of the `event:` field, if any. */
  event?: string;
  /** Value of the `id:` field, if any. */
  id?: string;
  /** Value of the `retry:` field (reconnection delay in ms), if any. */
  retry?: number;
}
