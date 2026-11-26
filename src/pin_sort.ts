// Alphanumeric comparison for pin-order terms (#_pin/dot/*, #_pin/*, #*/pin/*) in
// onEditorChange's items.sort(): one shared Intl.Collator with the same options the inline
// localeCompare calls passed ({ numeric: true, sensitivity: 'base' }), short-circuiting exact
// string equality so the ~80k empty-string pairs per ~2,400-item sort skip ICU collation.
// Produces the same ordering as `a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })`
// for every pair, including distinct strings that compare equal under base sensitivity (case,
// accents, or numeric leading zeros), because the fast path checks strict identity only.

const pinTermCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function comparePinTerm(a: string, b: string): number {
  return a === b ? 0 : pinTermCollator.compare(a, b)
}
