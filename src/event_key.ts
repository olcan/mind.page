// The key a keydown/keyup handler should compare against.
//
// Handlers prefer `e.code`, the PHYSICAL key, so that shortcuts survive keyboard layouts and
// so that Android soft keyboards (which report `e.key` as `Unidentified`) still work. That
// preference is unsafe for one class of input: a VIRTUAL keyboard types arbitrary characters
// by temporarily remapping spare physical keycodes, starting at 9, which is Escape. Dictation
// through `wtype` therefore delivers the first character of every transcription with
// `code: 'Escape'`, the next ones as `Digit1`, `Digit2`, ..., and as a transcription uses more
// distinct characters it climbs into `Backspace`, `Tab` and `Enter`. A handler reading `code`
// first takes its Escape/Backspace/Tab/Enter branch for what is plain text: in MindBox that
// cancelled the keystroke and blurred the editor after two or three characters, losing the
// rest of the transcription (issues/Dictated Text Triggers Escape And Blurs The Editor).
//
// `e.key` separates the two cases exactly, but not by length: a key value is either a KEY NAME
// (`Escape`, `Enter`, `ArrowUp`, `F5`, `Dead`, `Process` -- two or more ASCII alphanumerics,
// starting with a letter, per the UI Events key-value tables) or the CHARACTER the key produces,
// which can be one code unit (`T`), a surrogate pair (an emoji, `length` 2) or a base character
// with combining marks. So the test is "not a name", never "one character long": counting code
// units would let an emoji on the Escape keycode take the cancel branch again.
//
// Only the codes a real press reports with a NAMED key value are guarded, so every shortcut that
// compares a physical code (`KeyS`, `Slash`, `Backquote`, `Space`, the layout keys) is untouched,
// and a real press of a guarded key is untouched too: its `e.key` is a name (`NumpadEnter` reports
// `Enter`, a name, so it keeps its own code as before).
const REMAPPED_AS_NAMED =
  /^(Escape|Enter|NumpadEnter|Tab|Backspace|Delete|Insert|Home|End|Page(Up|Down)|Arrow(Up|Down|Left|Right)|F\d+)$/
const KEY_NAME = /^[A-Za-z][A-Za-z0-9]+$/

/**
 * The key to compare against in a keyboard handler.
 *
 * `e.code` (the physical key) as before, except when it names a key that a real press reports
 * with a NAMED `e.key` while this event's `e.key` is a character: the keycode was remapped by a
 * virtual keyboard (dictation) and the character is returned, so text is never read as a named
 * key. Falls back to `e.key` when `e.code` is empty (iOS pencil input, Android soft keyboards),
 * and to `''` for a missing event or key.
 */
export function eventKey(e: { code?: string; key?: string } | null | undefined): string {
  const code = e?.code || e?.key || ''
  const key = typeof e?.key === 'string' ? e.key : ''
  if (key && REMAPPED_AS_NAMED.test(code) && !KEY_NAME.test(key)) return key
  return code
}
