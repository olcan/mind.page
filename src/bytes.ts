// byte array/string conversion helpers (moved from util.js, which re-exports them: this typed
// module lets typescript modules such as crypto.ts use them under strict tsc)

// convert byte array (Uint8Array) -> byte string of code points <=255 (a.k.a. a "binary string")
// based on https://stackoverflow.com/a/20604561
export function byteArrayToString(array: Uint8Array): string {
  if (array.constructor.name != 'Uint8Array') throw new Error('invalid argument, expected Uint8Array')
  const len = array.length
  const inc = 65535 // max args, see https://stackoverflow.com/a/22747272
  let str = ''
  for (let i = 0; i < len; i += inc)
    str += String.fromCharCode.apply(null, array.subarray(i, Math.min(len, i + inc)) as unknown as number[])
  return str
}

// convert byte string -> byte array (Uint8Array), ensuring code points <= 255
// note this is much faster than Uint8Array.from despite checking each code point
export function byteStringToArray(str: string): Uint8Array<ArrayBuffer> {
  if (typeof str != 'string') throw new Error('invalid argument, expected string')
  const len = str.length
  const array = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i)
    if (code > 255) throw new Error(`unsupported code point ${code}>255 in string->Uint8Array conversion`)
    array[i] = code
  }
  return array
}

export function castArgToByteArray(x: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (x.constructor.name == 'Uint8Array') return x as Uint8Array
  else if (x.constructor.name == 'ArrayBuffer') return new Uint8Array(x as ArrayBuffer)
  else if (ArrayBuffer.isView(x)) {
    if (x.buffer?.constructor.name != 'ArrayBuffer') throw new Error('invalid ArrayBuffer view w/o buffer property')
    // preserve the view window: a typed-array or DataView slice must not expose its whole buffer
    return new Uint8Array(x.buffer, x.byteOffset, x.byteLength)
  } else throw new Error('argument is not an ArrayBuffer or view')
}

// concatenate Uint8Arrays or ArrayBuffers/views that can be cast to Uint8Arrays
export function concatByteArrays(...parts: (Uint8Array | ArrayBuffer | ArrayBufferView)[]): Uint8Array<ArrayBuffer> {
  let length = 0 // total byte length
  const arrays = parts.map(part => castArgToByteArray(part))
  for (const array of arrays) length += array.length
  const array = new Uint8Array(length)
  let offset = 0
  for (const part of arrays) {
    array.set(part, offset)
    offset += part.length
  }
  return array
}
