/** Tiny class combiner for static CSS-module classes and optional caller classes. */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}
