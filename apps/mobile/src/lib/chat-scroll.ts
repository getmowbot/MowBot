/** Top and bottom of something on screen (window coordinates). */
export interface Span {
  top: number;
  bottom: number;
}

/**
 * How far to scroll the chat (an inverted list: a larger offset shows older messages, content
 * moving down) so a field typed into sits between the header and the message bar. A field
 * taller than the room left keeps its top in view. 0: it is in view already.
 */
export function revealOffset(field: Span, visible: Span): number {
  if (field.top < visible.top) return visible.top - field.top;
  if (field.bottom > visible.bottom) {
    return -Math.min(field.bottom - visible.bottom, field.top - visible.top);
  }
  return 0;
}
