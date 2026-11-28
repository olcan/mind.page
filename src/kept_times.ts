// Whether a box-change handler call (onEditorChange in src/routes/index.svelte) soft-touches the
// listing item and id-matching items, and which query stays remembered as a kept-times visit
// (the owner, 2026-11-27).
//
// A raw slash command (untrimmed text starting with `/`) disables search in the route, so it has
// no listing item or id matches to protect and is treated like an empty query for remembering and
// matching (so prepending a space to a restored command turns it into an ordinary typed search).
//
// Three cases of the optional `keepTimes` argument:
// - `true` (Option+Down/Up/PageDown/PageUp walk, Option-click on a tag, arrow-key navigation,
//   browser Back/Forward): does not touch, and remembers the trimmed query (nothing for empty or
//   a raw slash command);
// - `false`, passed explicitly (plain click on a tag): drops any remembered query and touches;
// - omitted (`undefined`): keeps times while the trimmed non-command text matches the remembered
//   query (a passive re-ranking of the same query); any other text drops the remembered query and
//   touches.
export type KeptTimesStep = {
  kept: string | null
  touch: boolean
}

export function stepKeptTimes(kept: string | null, text: string, keepTimes?: boolean): KeptTimesStep {
  const key = text.startsWith('/') ? '' : text.trim()
  if (keepTimes === true) return { kept: key || null, touch: false }
  if (keepTimes === false) return { kept: null, touch: true }
  if (kept && key === kept) return { kept, touch: false }
  return { kept: null, touch: true }
}
