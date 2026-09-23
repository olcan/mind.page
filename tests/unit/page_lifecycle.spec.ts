import { expect, test } from '@playwright/test'
import { restoreAction } from '../../src/page_lifecycle.js'

// the page-cache restore (see src/page_lifecycle.ts): a persisted pageshow on a page whose
// Firestore client runs the persistent cache means the SDK's pagehide handler left that client
// dead (zombied, then shut down — or, on iPhone WebKit, stuck in a restricted queue), and the app
// recovers by a reload — at once, or after asking when an edit is unsaved

test('an ordinary load (pageshow without persisted) does nothing, unsaved edit or not', () => {
  expect(restoreAction({ persisted: false, persistentCache: true, unsaved: false })).toBe('none')
  expect(restoreAction({ persisted: false, persistentCache: true, unsaved: true })).toBe('none')
})

test('a restore reloads at once when nothing is unsaved', () => {
  expect(restoreAction({ persisted: true, persistentCache: true, unsaved: false })).toBe('reload')
})

test('a restore asks first when an edit is unsaved: the reload would discard it', () => {
  expect(restoreAction({ persisted: true, persistentCache: true, unsaved: true })).toBe('prompt')
})

test('a restore of the memory-cache client (the shared origin) does nothing: no pagehide handler shut it down', () => {
  expect(restoreAction({ persisted: true, persistentCache: false, unsaved: false })).toBe('none')
  expect(restoreAction({ persisted: true, persistentCache: false, unsaved: true })).toBe('none')
})
