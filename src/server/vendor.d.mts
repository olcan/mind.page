// types for the unit tests (tests/unit/vendor_route.spec.ts); the module is plain js, see vendor.mjs
import type { Router } from 'express'
export const MANIFEST_PATH: string
export function assetFile(dir: string, url: string): string
export function loadManifest(file?: string): Record<string, { type: string }>
export function vendoredAssets(options?: {
  dir?: string
  unlisted?: string
  manifest?: string | Record<string, { type: string }>
}): Router
