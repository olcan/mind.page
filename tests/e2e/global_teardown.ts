import { rmSync } from 'fs'

// the run's throwaway home (playwright.config.ts, E2E_HOME): its proxy secret was the run's own,
// and the directory goes with the run; only the directory this run created is removed
export default function globalTeardown(): void {
  const owned = process.env.E2E_HOME_OWNED
  if (owned && owned === process.env.E2E_HOME) rmSync(owned, { recursive: true, force: true })
}
