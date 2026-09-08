// declarations for src/e2e_lanes.js (plain esm shared by node scripts, the config and the bundle)
export const E2E_BASE_PORT: number
export const E2E_LANES: string[]
export function lanePort(lane: string): number
export function isLanePort(port: string | number | undefined): boolean
export function laneProject(port: string | number | undefined, base: string): string
