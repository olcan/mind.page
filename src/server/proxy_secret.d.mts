// types for the playwright config and the tests; the module is plain js, see proxy_secret.mjs
export const PROXY_SECRET_DIR: string
export const PROXY_SECRET_FILE: string
export function proxySecretPath(): string
export function loadProxySecret(options?: { create?: boolean }): string
export function isProxySecretPath(candidate: string): boolean
