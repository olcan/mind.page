import { expect, test } from '@playwright/test'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { extname, join, relative } from 'path'
import { fileURLToPath } from 'url'
import { E2E_BASE_PORT, E2E_LANES, emulatorFirestoreSettings, isLanePort, lanePort, laneProject } from '../../src/e2e_lanes.js'

// the e2e lanes (see src/e2e_lanes.js): ports, the lane-port test and the project id mapping the
// client, the server, the seed and the helpers all derive from
test('lanes: distinct consecutive ports from the base port, the first lane on the base port', () => {
  expect(E2E_LANES[0]).toBe('chromium')
  expect(E2E_LANES.map(lanePort)).toEqual(E2E_LANES.map((_, i) => E2E_BASE_PORT + i))
  expect(() => lanePort('nope')).toThrow(/unknown e2e lane/)
})

for (const [port, expected] of [
  ['3100', true],
  [3100, true],
  [String(E2E_BASE_PORT + E2E_LANES.length - 1), true],
  [String(E2E_BASE_PORT + E2E_LANES.length), false],
  ['', false], // a default port (production)
  [undefined, false],
  ['3000', false], // the dev server
  ['3100.5', false],
] as const)
  test(`lanes: ${JSON.stringify(port)} is ${expected ? '' : 'not '}a lane port`, () => expect(isLanePort(port)).toBe(expected))

test('lanes: an emulator connection alone turns the long-polling auto-detection off; any other connection leaves the SDK default', () => {
  expect(emulatorFirestoreSettings(true)).toEqual({ experimentalAutoDetectLongPolling: false })
  expect(emulatorFirestoreSettings(false)).toEqual({})
})

test('lanes: the project id — the base for the first lane and for any non-lane port, suffixed after it', () => {
  expect(laneProject(3100, 'p')).toBe('p')
  expect(laneProject('3101', 'p')).toBe('p-e2e1')
  expect(laneProject(lanePort('personal'), 'p')).toBe(`p-e2e${E2E_LANES.indexOf('personal')}`)
  expect(laneProject('', 'p')).toBe('p')
  expect(laneProject(undefined, 'p')).toBe('p')
  expect(laneProject(3000, 'p')).toBe('p')
})

// FILE ASSIGNMENT, read from the gate's own config (playwright.config.ts) as Playwright 1.62 assigns files
// (collectFilesForProject): a project takes a file under its testDir that has a test file's extension, that its
// testMatch takes and that its testIgnore does not, each pattern the project's own or else the config's
// (Playwright's default match without either), tried on the file's absolute path. A spec that no lane takes runs
// nowhere (a name added to WRITE_SPECS without a lane, a lane's only spec renamed), one that two lanes take runs
// twice (a lane's spec missing from WRITE_SPECS also runs in the chromium lane, which ignores that set), and a unit
// project that reads more than tests/unit collects every browser row again. A spec file that holds no test still
// passes: the rows themselves are compared with `npx playwright test --list`
test('lanes: file assignment — each spec file under tests/e2e goes to exactly one lane, each lane gets one, the unit project reads tests/unit, and the browser projects are the table', async () => {
  // the config makes a throwaway home and a secret in it unless one is supplied (the full gate's runner supplies
  // its own to this worker): give a standalone unit run one of its own, removed afterwards
  const supplied = process.env.E2E_HOME
  if (!supplied) process.env.E2E_HOME = mkdtempSync(join(tmpdir(), 'mindpage-e2e-home-unit-'))
  let config
  try {
    config = (await import('../../playwright.config.js')).default
  } finally {
    if (!supplied) {
      rmSync(process.env.E2E_HOME!, { recursive: true, force: true })
      delete process.env.E2E_HOME
    }
  }
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const unit = config.projects!.find(project => project.name == 'unit')
  expect(unit?.testDir ?? config.testDir, 'the unit project reads tests/unit alone').toBe('tests/unit')
  const projects = config.projects!.filter(project => project !== unit)
  expect(projects.map(project => project.name).sort(), 'the browser projects are the lanes of src/e2e_lanes.js').toEqual([...E2E_LANES].sort())
  expect(projects.filter(project => (project.testDir ?? config.testDir) != 'tests/e2e').map(project => project.name), 'lanes reading another directory').toEqual([])
  // the check reads the patterns the config uses, one RegExp or none, and refuses any other
  const pattern = (value: unknown): RegExp | undefined => {
    if (value === undefined || value instanceof RegExp) return value
    throw new Error(`a lane pattern this check does not read: ${String(value)}`)
  }
  // Playwright's test file extensions, checked before any pattern, and its default match
  const EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts', '.jsx', '.tsx', '.mjsx', '.mtsx', '.cjsx', '.ctsx'])
  const DEFAULT_MATCH = /\.(spec|test)\.(c|m)?[jt]sx?$/ // '**/*.@(spec|test).?(c|m)[jt]s?(x)'
  const lanes = projects.map(project => ({
    name: project.name!,
    match: pattern(project.testMatch ?? config.testMatch),
    ignore: pattern(project.testIgnore ?? config.testIgnore),
  }))
  const files = readdirSync(join(root, 'tests/e2e'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && EXTENSIONS.has(extname(entry.name))) // (the snapshot folders are named after their specs)
    .map(entry => join(entry.parentPath, entry.name))
  const specs = files.filter(file => DEFAULT_MATCH.test(file) || lanes.some(lane => lane.match?.test(file)))
  const byFile = specs.map(file => [relative(root, file), lanes.filter(lane => (lane.match ?? DEFAULT_MATCH).test(file) && !lane.ignore?.test(file)).map(lane => lane.name)] as const)
  expect(byFile.filter(([, names]) => names.length != 1), 'spec files in no lane or in more than one').toEqual([])
  const used = new Set(byFile.flatMap(([, names]) => names))
  expect(E2E_LANES.filter(name => !used.has(name)), 'lanes that get no spec file').toEqual([])
})
