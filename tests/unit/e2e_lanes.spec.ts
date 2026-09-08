import { expect, test } from '@playwright/test'
import { E2E_BASE_PORT, E2E_LANES, isLanePort, lanePort, laneProject } from '../../src/e2e_lanes.js'

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

test('lanes: the project id — the base for the first lane and for any non-lane port, suffixed after it', () => {
  expect(laneProject(3100, 'p')).toBe('p')
  expect(laneProject('3101', 'p')).toBe('p-e2e1')
  expect(laneProject(lanePort('personal'), 'p')).toBe(`p-e2e${E2E_LANES.indexOf('personal')}`)
  expect(laneProject('', 'p')).toBe('p')
  expect(laneProject(undefined, 'p')).toBe('p')
  expect(laneProject(3000, 'p')).toBe('p')
})
