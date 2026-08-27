import { expect, test } from '@playwright/test'
import { resolveFixedOwnerSecret, type AccountDoc, type FixedOwnerSecretDeps } from '../../src/secret.js'
import { hashSecretPhrase, encryptWithSecret } from '../../src/crypto.js'

// transition tests for the fixed-owner secret flow (see src/secret.ts): fail-closed fetch retry and
// phrase validation against real ciphertext — the corruption boundaries the e2e suite cannot drive
// deterministically. this flow is VALIDATION ONLY: registration moved to the caller's fresh
// candidate-keyed scan, because the documents fetched here are as old as the prompt

const doc = (id: string, data: Record<string, any>): AccountDoc => ({ id, data: () => ({ ...data }) })

function deps(overrides: Partial<FixedOwnerSecretDeps> & { uid?: string }): FixedOwnerSecretDeps & {
  calls: string[]
} {
  const calls: string[] = []
  const uid = overrides.uid ?? 'uid-1'
  return {
    calls,
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

test('the candidate is returned WITHOUT touching hidden documents: registration is the caller‘s fresh scan', async () => {
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const hidden = async (name: string) => ({
    hidden: true,
    cipher: await encryptWithSecret(JSON.stringify({ text: JSON.stringify({ name, item: {} }), attr: null }), secret),
  })
  // a CORRUPT hidden document would have thrown inside the old registration pass. validation must
  // not depend on any hidden document decrypting: it rests on finding one readable ciphertext
  const rows = [
    doc('z9', await hidden('global_store_x')),
    doc('h1', { hidden: true, cipher: 'CORRUPT-HIDDEN-ITEM' }),
    doc('p1', { text: '#plain' }),
  ]
  const d = deps({
    fetchAccountDocs: async () => {
      d.calls.push('fetch')
      return rows
    },
  })
  expect(await resolveFixedOwnerSecret(d)).toBe(secret)
  // exactly one fetch, one prompt, no repeated pass over the (prompt-aged) documents
  expect(d.calls).toEqual(['fetch', 'prompt'])
})
