import { expect, test } from '@playwright/test'
import { byteArrayToString, byteStringToArray, castArgToByteArray, concatByteArrays } from '../../src/bytes.js'

test('byte strings round-trip and reject code points over 255', () => {
  const array = new Uint8Array([0, 1, 127, 128, 255])
  expect(Array.from(byteStringToArray(byteArrayToString(array)))).toEqual(Array.from(array))
  expect(() => byteStringToArray('π')).toThrow(/code point/)
})

test('views are cast preserving their window, not their whole backing buffer', () => {
  const buffer = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer
  expect(Array.from(castArgToByteArray(new Uint8Array(buffer, 2, 3)))).toEqual([3, 4, 5])
  expect(Array.from(castArgToByteArray(new DataView(buffer, 1, 2)))).toEqual([2, 3])
  expect(Array.from(castArgToByteArray(buffer))).toEqual([1, 2, 3, 4, 5, 6])
})

test('concatByteArrays concatenates mixed inputs windowed correctly', () => {
  const buffer = new Uint8Array([9, 8, 7, 6]).buffer
  const out = concatByteArrays(new Uint8Array([1]), new Uint8Array(buffer, 1, 2), new DataView(buffer, 3, 1))
  expect(Array.from(out)).toEqual([1, 8, 7, 6])
})
