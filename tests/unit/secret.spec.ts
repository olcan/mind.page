import { expect, test } from '@playwright/test'
import { resolveFixedOwnerSecret, type AccountDoc, type FixedOwnerSecretDeps } from '../../src/secret.js'
import { hashSecretPhrase, encryptWithSecret } from '../../src/crypto.js'

// transition tests for the fixed-owner secret flow (see src/secret.ts): fail-closed fetch retry,
// phrase validation against real ciphertext, and hidden-item registration completing before the
// secret is returned — the corruption boundaries the e2e suite cannot drive deterministically

const doc = (id: string, data: Record<string, any>): AccountDoc => ({ id, data: () => ({ ...data }) })

function deps(overrides: Partial<FixedOwnerSecretDeps> & { uid?: string }): FixedOwnerSecretDeps & {
  calls: string[]
  registered: Record<string, any>[]
} {
  const calls: string[] = []
  const registered: Record<string, any>[] = []
  const uid = overrides.uid ?? 'uid-1'
  return {
    calls,
    registered,
    fetchAccountDocs: async () => {
      calls.push('fetch')
      return []
    },
    promptPhrase: async () => {
      calls.push('prompt')
      return 'phrase'
    },
    confirmRetry: async () => {
      calls.push('retry?')
      return true
    },
    reportWrongPhrase: async () => {
      calls.push('wrong')
    },
    hashPhrase: phrase => hashSecretPhrase(uid, phrase),
    registerHiddenItem: item => {
      calls.push('register:' + item.id)
      registered.push(item)
    },
    signOut: () => {
      calls.push('signout')
    },
    ...overrides,
  }
}

test('a failed fetch retries until the server answers, never falling through', async () => {
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  let failures = 2
  const d = deps({
    fetchAccountDocs: async () => {
      d.calls.push('fetch')
      if (failures-- > 0) throw new Error('unavailable')
      return [doc('a', { cipher })]
    },
  })
  expect(await resolveFixedOwnerSecret(d)).toBe(secret)
  expect(d.calls.filter(call => call == 'fetch')).toHaveLength(3)
  expect(d.calls.filter(call => call == 'retry?')).toHaveLength(2)
  expect(d.calls).not.toContain('signout')
})

test('declining the retry signs out and throws, and no phrase is ever accepted', async () => {
  const d = deps({
    fetchAccountDocs: async () => {
      throw new Error('unavailable')
    },
    confirmRetry: async () => false,
  })
  await expect(resolveFixedOwnerSecret(d)).rejects.toThrow(/cancelled/)
  expect(d.calls).toContain('signout')
  expect(d.calls).not.toContain('prompt')
})

test('a wrong phrase re-prompts and a cancelled prompt signs out', async () => {
  const secret = await hashSecretPhrase('uid-1', 'right')
  const cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  const phrases = ['wrong', 'right']
  const d = deps({
    fetchAccountDocs: async () => [doc('a', { cipher })],
    promptPhrase: async () => phrases.shift() ?? null,
  })
  expect(await resolveFixedOwnerSecret(d)).toBe(secret)
  expect(d.calls).toContain('wrong')

  const cancelled = deps({
    fetchAccountDocs: async () => [doc('a', { cipher })],
    promptPhrase: async () => null,
  })
  await expect(resolveFixedOwnerSecret(cancelled)).rejects.toThrow(/cancelled/)
  expect(cancelled.calls).toContain('signout')
})

test('a server-confirmed account with no ciphertext returns null without prompting', async () => {
  const d = deps({ fetchAccountDocs: async () => [doc('a', { text: '#plain' }), doc('b', { text: '#also' })] })
  expect(await resolveFixedOwnerSecret(d)).toBeNull()
  expect(d.calls).not.toContain('prompt')
})

test('hidden items are decrypted with the candidate and registered before the secret is returned', async () => {
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const hidden = async (id: string, name: string) => ({
    hidden: true,
    cipher: await encryptWithSecret(JSON.stringify({ text: JSON.stringify({ name, item: { v: id } }), attr: null }), secret),
  })
  const d = deps({
    fetchAccountDocs: async () => [
      doc('h1', await hidden('h1', 'global_store_a')),
      doc('h2', await hidden('h2', 'global_store_b')),
      doc('p1', { text: '#plain' }),
    ],
  })
  const resolved = await resolveFixedOwnerSecret(d)
  expect(resolved).toBe(secret)
  // both hidden documents were registered (decrypted, cipher cleared) before resolution: a
  // concurrent save awaiting this operation can only ever see a fully registered index
  expect(d.registered.map(item => item.id).sort()).toEqual(['h1', 'h2'])
  for (const item of d.registered) {
    expect(item.cipher).toBeNull()
    expect(item.text).toContain('global_store_')
  }
  expect(d.calls.indexOf('register:h2')).toBeLessThan(d.calls.length)
})
