// Strips an own top-level GitHub `token` from a plain item attribute map (as stored on or read
// from a Firestore record) without mutating the input. Nullish values, primitives, arrays, and
// objects without an own `token` pass through unchanged by reference; a map with an own `token`
// comes back as a shallow plain-object copy without it (not class-preserving; Firestore attribute
// maps are plain objects, and the generic return type `T` stays wide until a typed caller needs
// narrowing). An installation token belongs to the browser (`mindpage_github_token`) or the
// encrypted `#updater`/`#pusher` hidden stores, never to visible item attributes or their saved
// copies (`items`, `history`). Applied at the read boundary (`decryptItem`) and write boundary
// (before `saveItem`'s plaintext snapshot `written`, in `encryptItem`, and to live `item.attr`
// in `onSaveDone`) so legacy records lose `attr.token` on their next app save and an older
// `#updater` mutating live `item.attr.token` cannot persist one or break own-write matching.
export function stripAttrToken<T>(attr: T): T {
  if (!attr || typeof attr !== 'object' || Array.isArray(attr)) return attr
  if (!Object.prototype.hasOwnProperty.call(attr, 'token')) return attr
  const copy = { ...(attr as Record<string, unknown>) }
  delete copy.token
  return copy as T
}
