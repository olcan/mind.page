import { expect, test } from '@playwright/test'
import { restoreAction, resumeAction, ResumeSchedule, RESUME_PROBE_AFTER_MS } from '../../src/page_lifecycle.js'

// the page-cache restore (see src/page_lifecycle.ts): a persisted pageshow on a page whose
// Firestore client runs the persistent cache means the SDK's pagehide handler ran on that client
// (on iPhone WebKit and Safari 14-16 a restricted queue where every operation hangs; elsewhere a
// shutdown() that takes the tab out of the multi-tab protocol), and the app recovers by a reload
// — at once, or after asking when an edit is unsaved

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

// the resume probe (see src/page_lifecycle.ts): a page turning visible after a long hide reads
// its own instance record from the server with a deadline; the SCHEDULE (review 1 R4) keeps a
// qualifying check pending through every interruption until an attempt of it is accepted; a
// timeout recovers (reload, or ask when an edit is unsaved), an answer or an error leaves the
// page alone

const LONG = RESUME_PROBE_AFTER_MS // 30 minutes: the rows' hides are relative to it
const signedIn = { anonymous: false }

test('a long hide raises a check probed at once online; a short hide, an anonymous page or nothing pending raises none', () => {
  const s = new ResumeSchedule()
  expect(s.shown({ hiddenMs: LONG - 1, online: true, ...signedIn })).toBe(0)
  expect(s.shown({ hiddenMs: 0, online: true, ...signedIn })).toBe(0) // never hidden
  expect(s.shown({ hiddenMs: LONG, online: true, anonymous: true })).toBe(0)
  expect(s.pending, 'an anonymous page raises no check').toBe(0)
  expect(s.shown({ hiddenMs: LONG, online: true, ...signedIn })).toBe(LONG)
  const attempt = s.begin()
  expect(s.settled(attempt), 'the current attempt is accepted').toBe(true)
  expect(s.pending, 'the check is done').toBe(0)
  expect(s.shown({ hiddenMs: 1_000, online: true, ...signedIn }), 'nothing pending after it').toBe(0)
})

test('a resume offline defers the check to the online event, run only with the page visible', () => {
  const s = new ResumeSchedule()
  expect(s.shown({ hiddenMs: 3_600_000, online: false, ...signedIn })).toBe(0)
  expect(s.online({ visible: false, ...signedIn }), 'hidden again when the network returned').toBe(0)
  expect(s.online({ visible: true, anonymous: true })).toBe(0)
  expect(s.online({ visible: true, ...signedIn })).toBe(3_600_000)
  expect(s.settled(s.begin())).toBe(true)
  expect(s.online({ visible: true, ...signedIn }), 'done').toBe(0)
})

test('an attempt invalidated by a hide is stale, and the check runs afresh at the next show, its hide short or not', () => {
  const s = new ResumeSchedule()
  expect(s.shown({ hiddenMs: LONG + 30_000, online: true, ...signedIn })).toBe(LONG + 30_000)
  const first = s.begin()
  s.invalidate() // a one-second app switch during the probe
  expect(s.shown({ hiddenMs: 1_000, online: true, ...signedIn }), 'the pending check, not the short hide').toBe(LONG + 30_000)
  const second = s.begin()
  expect(s.settled(first), 'the old attempt is stale').toBe(false)
  expect(s.pending, 'and left the check pending').toBe(LONG + 30_000)
  expect(s.settled(second)).toBe(true)
  expect(s.pending).toBe(0)
})

test('an attempt invalidated by a connection drop is stale, and the online event runs the check afresh', () => {
  const s = new ResumeSchedule()
  expect(s.shown({ hiddenMs: LONG + 60_000, online: true, ...signedIn })).toBe(LONG + 60_000)
  const first = s.begin()
  s.invalidate() // offline before the answer
  expect(s.settled(first)).toBe(false)
  expect(s.online({ visible: true, ...signedIn }), 'the pending check').toBe(LONG + 60_000)
  expect(s.settled(s.begin())).toBe(true)
})

test('a deferred check interrupted before it starts survives the interruption', () => {
  const s = new ResumeSchedule()
  expect(s.shown({ hiddenMs: LONG + 45_000, online: false, ...signedIn }), 'deferred').toBe(0)
  s.invalidate() // hidden again before the network returned
  expect(s.shown({ hiddenMs: 2_000, online: true, ...signedIn }), 'the pending check at the next show').toBe(LONG + 45_000)
  expect(s.settled(s.begin())).toBe(true)
})

test('a later long hide replaces the pending check\'s length; a later short one keeps it', () => {
  const s = new ResumeSchedule()
  s.shown({ hiddenMs: LONG + 20_000, online: false, ...signedIn })
  expect(s.shown({ hiddenMs: LONG + 90_000, online: false, ...signedIn })).toBe(0)
  expect(s.pending).toBe(LONG + 90_000)
  s.shown({ hiddenMs: 500, online: false, ...signedIn })
  expect(s.pending).toBe(LONG + 90_000)
})

test('a timed-out probe reloads, or asks first when an edit is unsaved; an answer or an error changes nothing', () => {
  expect(resumeAction({ outcome: 'timeout', unsaved: false })).toBe('reload')
  expect(resumeAction({ outcome: 'timeout', unsaved: true })).toBe('prompt')
  for (const outcome of ['ok', 'error'] as const) {
    expect(resumeAction({ outcome, unsaved: false })).toBe('none')
    expect(resumeAction({ outcome, unsaved: true })).toBe('none')
  }
})
