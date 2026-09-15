#!/usr/bin/env node
// the vendored cdn assets' cache (see src/server/vendor.mjs), the only writer of the manifest:
//   node tests/e2e/vendor.mjs add <url>...   fetch each url online, cache it, pin its type in the manifest
//   node tests/e2e/vendor.mjs fill           fetch the manifest's assets missing from the cache (online)
//   node tests/e2e/vendor.mjs check          list the manifest's assets missing from the cache, exit 2 if any
// the cache: ~/.cache/mindpage/vendor/<sha256 of the url> (VENDOR_DIR), pinned by
// tests/e2e/vendor_manifest.json (url -> content type). assets are fetched with Desktop Chrome's
// user agent (a cdn may answer by user agent); a fetch that fails fails the command (exit 2) and
// pins nothing, so a successful `add` has cached the assets it pinned; `fill` and `check` are
// what establish the whole manifest's availability
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { devices } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
// VENDOR_MANIFEST: another manifest (the unit tests' disposable copy); the gate uses the repo's
const MANIFEST_PATH = process.env.VENDOR_MANIFEST ?? resolve(here, 'vendor_manifest.json')
const VENDOR_DIR = process.env.VENDOR_DIR ?? join(homedir(), '.cache', 'mindpage', 'vendor')
const USER_AGENT = devices['Desktop Chrome'].userAgent

const assetFile = url => join(VENDOR_DIR, createHash('sha256').update(url).digest('hex'))
const manifest = () => (existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : {})
const saveManifest = entries => {
  const sorted = Object.fromEntries(
    Object.keys(entries)
      .sort()
      .map(url => [url, entries[url]]),
  )
  writeFileSync(MANIFEST_PATH, JSON.stringify(sorted, null, 2) + '\n')
}

// fetch a url into the cache (a temporary file renamed into place, so a reader never sees a
// partial asset); returns its content type
const fetchAsset = async url => {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`http ${response.status}`)
  const type = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim()
  mkdirSync(VENDOR_DIR, { recursive: true })
  const file = assetFile(url)
  writeFileSync(file + '.part', Buffer.from(await response.arrayBuffer()))
  renameSync(file + '.part', file)
  return type
}

const fetchAll = async urls => {
  const types = {}
  const failed = []
  for (const url of urls) {
    try {
      types[url] = await fetchAsset(url)
    } catch (error) {
      failed.push(`${url}: ${error?.message ?? error}`)
    }
  }
  if (failed.length) {
    console.error(`vendored assets could not be fetched (offline? the cache under ${VENDOR_DIR} must be complete):`)
    for (const line of failed) console.error(`  ${line}`)
    process.exit(2)
  }
  return types
}

const [command, ...args] = process.argv.slice(2)
if (command == 'add' && args.length) {
  const entries = manifest()
  const types = await fetchAll(args)
  for (const url of args) entries[url] = { type: types[url] }
  saveManifest(entries)
  console.log(`vendored ${args.length} assets into ${VENDOR_DIR}; manifest: ${Object.keys(entries).length} assets`)
} else if (command == 'fill' || command == 'check') {
  const entries = manifest()
  const missing = Object.keys(entries).filter(url => !existsSync(assetFile(url)))
  if (command == 'fill' && missing.length) {
    await fetchAll(missing)
    console.log(`vendored ${missing.length} assets into ${VENDOR_DIR}`)
  } else if (missing.length) {
    console.error(`vendored assets missing from ${VENDOR_DIR}:`)
    for (const url of missing) console.error(`  ${url}`)
    process.exit(2)
  } else console.log(`vendored assets complete: ${Object.keys(entries).length} in ${VENDOR_DIR}`)
} else {
  console.error('usage: vendor.mjs add <url>... | fill | check')
  process.exit(64)
}
