// the local proxy's per-host secret (vault design mind_task_agents 9.7 and 9.9): every forwarding
// path of the local-only proxy requires it, the browser's included. it lives in the REAL home
// (`~/.mindpage/proxy_secret`, mode 0600), where a sandboxed worker cannot read it (the worker's
// HOME is a scratch one and the real home is hidden), so a worker's plain http request to an
// unsandboxed local server cannot relay to the internet through it. the unsandboxed servers read
// it (creating it when missing), the owner provisions it to a browser once per profile
// (`/_proxy_secret <value>` stores it in localStorage), the e2e tests read the same file, and a
// worker's own in-sandbox lane servers create theirs under the scratch home (their proxy reaches
// nothing remote anyway). never log it, never write it into test artifacts
import { randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

export const PROXY_SECRET_DIR = '.mindpage'
export const PROXY_SECRET_FILE = 'proxy_secret'

// the secret file's path under the current HOME (the real home for the owner's servers, the
// scratch home for a sandboxed worker's)
export function proxySecretPath() {
  return path.join(os.homedir(), PROXY_SECRET_DIR, PROXY_SECRET_FILE)
}

// the secret, read from its file; created (dir 0700, file 0600, 32 random bytes in base64url)
// when missing and `create` is set. an unreadable or empty file is an error: the proxy must not
// come up unauthenticated
export function loadProxySecret({ create = false } = {}) {
  const file = proxySecretPath()
  try {
    const stored = fs.readFileSync(file, 'utf8').trim()
    if (stored) return stored
    throw new Error(`empty proxy secret file ${file}`)
  } catch (err) {
    if (err?.code != 'ENOENT' || !create) throw err
  }
  const secret = randomBytes(32).toString('base64url')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(file, secret + '\n', { mode: 0o600, flag: 'wx' })
    return secret
  } catch (err) {
    if (err?.code != 'EEXIST') throw err
    return loadProxySecret() // another local server created it meanwhile: read it as above
  }
}

// whether an absolute path names the secret, its directory, or anything under it, aliases
// included (symlinks resolved; a missing path is compared as given): the filesystem-serving
// routes refuse these, so a localhost request cannot read the credential through the server
export function isProxySecretPath(candidate) {
  const dir = path.dirname(proxySecretPath())
  const resolved = target => {
    try {
      return fs.realpathSync(target)
    } catch {
      return path.resolve(target)
    }
  }
  const secretDir = resolved(dir)
  const given = resolved(candidate)
  return given == secretDir || given.startsWith(secretDir + path.sep)
}
