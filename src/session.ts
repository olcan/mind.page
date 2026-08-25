// auth-state decision for the session (extracted from the onAuthStateChanged callback in
// index.svelte; table-tested in tests/unit/session.spec.ts). the callback owns every effect —
// reloads, modals, user/session state, the session cookie, starting the firestore listeners —
// and this function only decides which branch runs. the sign-in/sign-out FLOWS stay in the
// component deliberately: they are popup/reload/browser plumbing whose extraction would be
// dependency-injection without testable substance (recorded in the plan).

export type AuthStateFacts = {
  // a sign-in or sign-out flow is in progress in THIS tab; it ends in a reload, and auth events
  // fired during it must not be treated as external changes
  signingIn: boolean
  signingOut: boolean
  // an auth state was already received by this page load: any further event is an external
  // transition (e.g. sign-in/sign-out from another tab)
  authStateReceived: boolean
  hasUser: boolean
  // the page is the anonymous (public) account: a null user is its normal signed-out state
  anonymous: boolean
}

export type AuthStateAction =
  // mid sign-in/out in this tab: the flow reloads when done
  | 'ignore_transition'
  // auth changed after this page initialized (another tab signed in or out): reload to re-enter
  // through a consistent state
  | 'reload'
  // expected a user (non-anonymous page) but none arrived: offer retry/cancel
  | 'signin_failed'
  // a user arrived: apply it (session state, cookie, users doc) and start the listeners
  | 'apply_user'
  // no user on the anonymous page: start the listeners as the signed-out visitor
  | 'anonymous'

export function authStateAction(facts: AuthStateFacts): AuthStateAction {
  if (facts.signingIn || facts.signingOut) return 'ignore_transition'
  if (facts.authStateReceived) return 'reload'
  if (!facts.hasUser) return facts.anonymous ? 'anonymous' : 'signin_failed'
  return 'apply_user'
}
