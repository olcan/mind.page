import { expect, test } from '@playwright/test'
import { authStateAction, type AuthStateFacts } from '../../src/session.js'

// table tests for the auth-state decision (see src/session.ts); each case documents a session
// transition the callback in index.svelte acts on

const base: AuthStateFacts = {
  signingIn: false,
  signingOut: false,
  authStateReceived: false,
  hasUser: true,
  anonymous: false,
}

const cases: [string, Partial<AuthStateFacts>, ReturnType<typeof authStateAction>][] = [
  ['a user on first auth state applies', {}, 'apply_user'],
  ['no user on the anonymous page starts the signed-out visitor', { hasUser: false, anonymous: true }, 'anonymous'],
  ['no user on a personal page offers retry', { hasUser: false }, 'signin_failed'],
  // sign-in/out flows in this tab end in a reload; their auth events are not external changes
  ['events during sign-in are ignored', { signingIn: true }, 'ignore_transition'],
  ['events during sign-out are ignored', { signingOut: true, hasUser: false }, 'ignore_transition'],
  // any auth change after this page load initialized is external (another tab): re-enter clean
  ['a second auth state reloads', { authStateReceived: true }, 'reload'],
  ['a second auth state reloads even without a user', { authStateReceived: true, hasUser: false, anonymous: true }, 'reload'],
  // the in-tab flows win over staleness: a mid-sign-out event never triggers the reload branch
  ['sign-out in progress beats the external-change reload', { signingOut: true, authStateReceived: true }, 'ignore_transition'],
]

for (const [name, overrides, expected] of cases)
  test(name, () => {
    expect(authStateAction({ ...base, ...overrides })).toBe(expected)
  })
