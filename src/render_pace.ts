// the pace of the initial rendering (index.svelte renderRange): items are rendered in turns, and
// each turn's size follows the previous turn's wall time so that a turn stays near the budget —
// one item per turn when items are expensive (a phone, or heavy items), up to `max` when they are
// cheap. the previous size is the reference: `rendered` items took `elapsedMs`, so the budget
// affords rendered * budget / elapsed. a turn that took no measurable time keeps growing
export function nextRenderChunk(rendered: number, elapsedMs: number, budgetMs: number, max = 10): number {
  if (!(rendered > 0)) return 1
  const affordable = elapsedMs > 0 ? (rendered * budgetMs) / elapsedMs : max
  return Math.max(1, Math.min(max, Math.floor(affordable)))
}
