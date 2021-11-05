// from https://stackoverflow.com/a/2901298
export function numberWithCommas(x) {
  var parts = x.toString().split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

export function blockRegExp(type_regex) {
  if (''.match(type_regex)) throw new Error('invalid block type regex')
  return new RegExp('(^|\\n) *```(' + type_regex + ')\\n(?: *```|.*?\\n *```)', 'gs')
}

export function extractBlock(text, type, keep_empty_lines = false) {
  // NOTE: this regex is mostly consistent w/ that in updateTextDivs in Editor.svelte or toHTML in Item.svelte, and in particular allows a colon-separated prefix and suffix, w/ the suffix required to contain a period; only notable difference is that the type is allowed to match the colon-separated suffix if it matches exactly
  let insideBlock = false
  let regex = RegExp('^\\s*```(?:\\S+:)?' + type + '(?:_hidden|_removed)?(?::\\S*\\.\\S*)?(?:\\s|$)')
  const lines = text.split('\n').map(line => {
    if (!insideBlock && line.match(regex)) insideBlock = true
    else if (insideBlock && line.match(/^\s*```/)) insideBlock = false
    if (line.match(/^\s*```/)) return ''
    return insideBlock ? line : ''
  })
  return keep_empty_lines
    ? lines.join('\n')
    : lines
        .filter(t => t)
        .join('\n')
        .trim()
}

export function highlight(code, language) {
  if (!window.hljs) return code
  // https://github.com/highlightjs/highlight.js/blob/master/SUPPORTED_LANGUAGES.md
  //if (language=="") return hljs.highlightAuto(code).value;
  language = language.replace(/(?:_removed|_hidden)$/, '')
  if (language == '_log') {
    return code
      .split('\n')
      .map(line =>
        line
          .replace(/^(ERROR:.*)$/, '<span class="console-error">$1</span>')
          .replace(/^(WARNING:.*)$/, '<span class="console-warn">$1</span>')
          .replace(/^(INFO:.*)$/, '<span class="console-info">$1</span>')
          .replace(/^(DEBUG:.*)$/, '<span class="console-debug">$1</span>')
      )
      .join('\n')
  }
  // drop any _suffix if language does not start with _ (_lang is editor-only)
  if (!language.startsWith('_')) language = language.replace(/(^\w+?)_.+$/, '$1')
  // highlight json as javascript so e.g. quotes are not required for keys
  if (language == 'json') language = 'js'
  language = window.hljs.getLanguage(language) ? language : 'plaintext'
  return window.hljs.highlight(code, { language }).value
}

export function parseTags(text) {
  const tags = _.uniq(
    Array.from(
      text
        .replace(/(?:^|\n) *```.*?\n *```/gs, '') // remove multi-line blocks
        // NOTE: currently we miss indented blocks that start with bullets (since it requires context)
        .replace(/(?:^|\n)     *[^-*+ ].*(?:$|\n)/g, '') // remove 4-space indented blocks
        .replace(/(^|[^\\])`.*?`/g, '$1') // remove inline code spans
        .replace(/(^|[^\\])\$?\$`.+?`\$\$?/g, '$1') // remove math
        .replace(/(^|[^\\])<script.*?>.*?<\/script>/gs, '$1') // remove scripts (can be multi-line)
        .replace(/(^|[^\\])<style>.*?<\/style>/gs, '$1') // remove styles (can be multi-line)
        .replace(/(^|[^\\])<\/?\w.*?>/g, '$1') // remove html tags
        .replace(/(^|[^\\])<!--.*?-->/g, '$1') // remove html comment tags
        .replace(/(^|[^\\])<<.*?>>/g, '$1') // remove macros
        .replace(/(^|[^\\])@\{.*?\}@/g, '$1') // remove macros
        //.matchAll(/(?:^|[\s<>&,.;:"'`(){}\[\]])(#[^#\s<>&,.;:"'`(){}\[\]]+)/g),
        .matchAll(/(?:^|\s|\()(#[^#\s<>&,.;:!"'`(){}\[\]]+)/g),
      m => m[1]
    )
  )
  return {
    raw: _.uniq(tags),
    all: _.uniq(tags.map(t => t.replace(/^#_/, '#'))),
    visible: tags.filter(t => !t.startsWith('#_')),
    hidden: tags.filter(t => t.startsWith('#_')).map(t => t.replace(/^#_/, '#')),
  }
}

export function parseLabel(text, keep_case = false) {
  const lctext = text.toLowerCase()
  const tags = parseTags(lctext)
  // if item stats with visible #tag, it is taken as a "label" for the item
  // (we allow some html tags/macros to precede the label tag for styling purposes)
  const header = lctext.replace(/^<.*>\s+#/, '#').match(/^.*?(?:\n|$)/)[0]
  const label = header.startsWith(tags.visible[0]) ? tags.visible[0] : ''
  if (keep_case) return label ? text.replace(/^<.*>\s+#/, '#').match(/^#\S+/)[0] : ''
  return label
}

export function renderTag(tag) {
  return tag.replace(/^#_?\/*(?=[^\/])/, '')
}

// export function regexEscape(str) {
//   return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
// }

function count_unescaped(str, substr) {
  if (substr.length == 0) throw 'substr can not be empty'
  let count = 0
  let pos = 0
  while ((pos = str.indexOf(substr, pos)) >= 0) {
    if (str[pos - 1] != '\\') count++
    pos += substr.length
  }
  return count
}

export function isBalanced(expr) {
  return (
    count_unescaped(expr, '`') % 2 == 0 &&
    count_unescaped(expr, "'") % 2 == 0 &&
    count_unescaped(expr, '"') % 2 == 0 &&
    // NOTE: */ can be confused w/ ending of regex so we allow mismatch if / are even (not fool-proof but should be good enough for now)
    (count_unescaped(expr, '/*') == count_unescaped(expr, '*/') || count_unescaped(expr, '/') % 2 == 0) &&
    count_unescaped(expr, '{') == count_unescaped(expr, '}') &&
    count_unescaped(expr, '[') == count_unescaped(expr, ']') &&
    count_unescaped(expr, '(') == count_unescaped(expr, ')')
  )
}

// NOTE: element cache invalidation should be triggered on any script/eval errors, but also whenever an item is run or <script>s executed since code dependencies can never be fully captured in cache keys (even with deephash)
export function invalidateElemCache(id) {
  if (!window['_elem_cache'][id]) return
  // console.warn("invalidateElemCache for ", id);
  Object.values(window['_elem_cache'][id]).forEach(elem => {
    const key = elem.getAttribute('_cache_key')
    // we allow some items to skip invalidation, e.g. to be intentionally reused across runs
    if (elem.hasAttribute('_skip_invalidation')) return
    // console.warn("deleting from _elem_cache", key);
    delete window['_elem_cache'][id][key]
    // destroy all children and SELF w/ _destroy attribute (and property)
    elem.querySelectorAll('[_destroy]').forEach(e => e['_destroy']())
    if (elem._destroy) elem._destroy()
    // remove unless still live on item (then should be removed on svelte update)
    // element removal also prevents any pending (via setTimeout) chart renders
    // ensuring svelte update may require a version increment to invalidate svelte content cache
    if (!elem.closest('.item')) elem.remove()
  })
}

export function adoptCachedElem(elem) {
  let cachediv = document.getElementById('cache-div')
  if (cachediv.contains(elem)) return
  elem['_width'] = elem.style.width
  elem['_height'] = elem.style.height
  elem['_position'] = elem.style.position
  const computed = getComputedStyle(elem)
  elem.style.width = computed.width
  elem.style.height = computed.height
  elem.style.position = 'absolute'
  elem.remove()
  cachediv.appendChild(elem)
}

export function checkElemCache() {
  if (!window['_elem_cache']) window['_elem_cache'] = {}
  Object.keys(window['_elem_cache']).forEach(id => {
    Object.values(window['_elem_cache'][id]).forEach(elem => {
      if (document.contains(elem)) return // elem is already on the page
      const key = elem.getAttribute('_cache_key')
      // console.warn("orphaned cached element", key, "from item", window["_item"](id).name);
      // if element has zero-width, destroy it, otherwise adopt it
      if (elem.offsetWidth == 0) {
        delete window['_elem_cache'][id][key]
        // destroy all children and SELF w/ _destroy attribute (and property)
        elem.querySelectorAll('[_destroy]').forEach(e => e['_destroy']())
        if (elem._destroy) elem._destroy()
        elem.remove() // prevents any pending chart also
        // console.warn("destroyed zero-width orphaned cached element", key, "from item", window["_item"](id).name);
      } else {
        adoptCachedElem(elem)
      }
    })
  })
}

import utf8 from 'utf8' // ~18K

// utf16 -> utf8
export function encode_utf8(str) {
  return utf8.encode(str)
}

// utf8 -> utf16
export function decode_utf8(utf8) {
  return utf8.decode(utf8)
}

// utf16 -> utf8 array (Uint8Array)
const utf8_encoder = new TextEncoder('utf-8')
export function encode_utf8_array(str) {
  return utf8_encoder.encode(str) // string (utf16) -> Uint8Array
}

// utf8 array (Uint8Array) -> utf16
const utf8_decoder = new TextDecoder('utf-8')
export function decode_utf8_array(utf8) {
  return utf8_decoder.decode(utf8) // Uint8Array -> string (utf16)
}

// utf16 -> base64(ascii)
export function encode_base64(str) {
  return utf8.encode(str).toString('base64')
}

// base64(ascii) -> utf16
export function decode_base64(base64) {
  return utf8.decode(Buffer.from(base64, 'base64'))
}

// generic hasher that handles non-strings
// if x._hash is defined, uses that as a pre-computed hash
// default stringifier is toString for functions, JSON.stringify otherwise
// default hasher is hash_64_fnv1a, returns 64-bit hex string
export function hash(x, stringifier, hasher) {
  if (typeof x == 'undefined') return undefined
  if (x._hash) return x._hash // precomputed hash
  if (typeof x != 'string') {
    stringifier ??= typeof x == 'function' ? x => x.toString() : JSON.stringify
    x = stringifier(x)
  }
  hasher ??= hash_64_fnv1a
  return hasher(x)
}

// utf16 -> 32-bit integer using classical dbj2 algorithm, xor variant
export function hash_32_djb2(str) {
  str = encode_utf8(str) // classical dbj2 was designed for bytes (unsigned char)
  let hash = 5381 // see https://stackoverflow.com/q/10696223
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i) // xor variant
  }
  return hash >>> 0
}

// ~135K is too big so we copy relevant parts below
// import fnv1a from 'fnv-plus'

// utf16 -> 32-bit integer using fnv-1a algorithm
// _hash32_1a_fast_utf from https://github.com/tjwebb/fnv-plus/blob/1e2ce68a07cb7dd4c3c85364f3d8d96c95919474/index.js#L341
export function hash_32_fnv1a(str) {
  var c,
    i,
    l = str.length,
    t0 = 0,
    v0 = 0x9dc5,
    t1 = 0,
    v1 = 0x811c

  for (i = 0; i < l; i++) {
    c = str.charCodeAt(i)
    if (c < 128) {
      v0 ^= c
    } else if (c < 2048) {
      v0 ^= (c >> 6) | 192
      t0 = v0 * 403
      t1 = v1 * 403
      t1 += v0 << 8
      v1 = (t1 + (t0 >>> 16)) & 65535
      v0 = t0 & 65535
      v0 ^= (c & 63) | 128
    } else if ((c & 64512) == 55296 && i + 1 < l && (str.charCodeAt(i + 1) & 64512) == 56320) {
      c = 65536 + ((c & 1023) << 10) + (str.charCodeAt(++i) & 1023)
      v0 ^= (c >> 18) | 240
      t0 = v0 * 403
      t1 = v1 * 403
      t1 += v0 << 8
      v1 = (t1 + (t0 >>> 16)) & 65535
      v0 = t0 & 65535
      v0 ^= ((c >> 12) & 63) | 128
      t0 = v0 * 403
      t1 = v1 * 403
      t1 += v0 << 8
      v1 = (t1 + (t0 >>> 16)) & 65535
      v0 = t0 & 65535
      v0 ^= ((c >> 6) & 63) | 128
      t0 = v0 * 403
      t1 = v1 * 403
      t1 += v0 << 8
      v1 = (t1 + (t0 >>> 16)) & 65535
      v0 = t0 & 65535
      v0 ^= (c & 63) | 128
    } else {
      v0 ^= (c >> 12) | 224
      t0 = v0 * 403
      t1 = v1 * 403
      t1 += v0 << 8
      v1 = (t1 + (t0 >>> 16)) & 65535
      v0 = t0 & 65535
      v0 ^= ((c >> 6) & 63) | 128
      t0 = v0 * 403
      t1 = v1 * 403
      t1 += v0 << 8
      v1 = (t1 + (t0 >>> 16)) & 65535
      v0 = t0 & 65535
      v0 ^= (c & 63) | 128
    }
    t0 = v0 * 403
    t1 = v1 * 403
    t1 += v0 << 8
    v1 = (t1 + (t0 >>> 16)) & 65535
    v0 = t0 & 65535
  }

  return ((v1 << 16) >>> 0) + v0
}

// utf16 -> 52-bit integer using fnv-1a algorithm
// _hash52_1a_fast_utf from https://github.com/tjwebb/fnv-plus/blob/1e2ce68a07cb7dd4c3c85364f3d8d96c95919474/index.js#L436
export function hash_52_fnv1a(str) {
  var c,
    i,
    l = str.length,
    t0 = 0,
    v0 = 0x2325,
    t1 = 0,
    v1 = 0x8422,
    t2 = 0,
    v2 = 0x9ce4,
    t3 = 0,
    v3 = 0xcbf2

  for (i = 0; i < l; i++) {
    c = str.charCodeAt(i)
    if (c < 128) {
      v0 ^= c
    } else if (c < 2048) {
      v0 ^= (c >> 6) | 192
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= (c & 63) | 128
    } else if ((c & 64512) == 55296 && i + 1 < l && (str.charCodeAt(i + 1) & 64512) == 56320) {
      c = 65536 + ((c & 1023) << 10) + (str.charCodeAt(++i) & 1023)
      v0 ^= (c >> 18) | 240
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= ((c >> 12) & 63) | 128
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= ((c >> 6) & 63) | 128
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= (c & 63) | 128
    } else {
      v0 ^= (c >> 12) | 224
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= ((c >> 6) & 63) | 128
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= (c & 63) | 128
    }
    t0 = v0 * 435
    t1 = v1 * 435
    t2 = v2 * 435
    t3 = v3 * 435
    t2 += v0 << 8
    t3 += v1 << 8
    t1 += t0 >>> 16
    v0 = t0 & 65535
    t2 += t1 >>> 16
    v1 = t1 & 65535
    v3 = (t3 + (t2 >>> 16)) & 65535
    v2 = t2 & 65535
  }

  return (v3 & 15) * 281474976710656 + v2 * 4294967296 + v1 * 65536 + (v0 ^ (v3 >> 4))
}

// utf16 -> 64-bit hex string using fnv-1a algorithm
// _hash64_1a_fast_utf from https://github.com/tjwebb/fnv-plus/blob/1e2ce68a07cb7dd4c3c85364f3d8d96c95919474/index.js#L530
// note dependency on a precomputed hl array outside of function scope
let hl = new Array(256)
for (let i = 0; i < 256; i++) {
  hl[i] = ((i >> 4) & 15).toString(16) + (i & 15).toString(16)
}
export function hash_64_fnv1a(str) {
  var c,
    i,
    l = str.length,
    t0 = 0,
    v0 = 0x2325,
    t1 = 0,
    v1 = 0x8422,
    t2 = 0,
    v2 = 0x9ce4,
    t3 = 0,
    v3 = 0xcbf2

  for (i = 0; i < l; i++) {
    c = str.charCodeAt(i)
    if (c < 128) {
      v0 ^= c
    } else if (c < 2048) {
      v0 ^= (c >> 6) | 192
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= (c & 63) | 128
    } else if ((c & 64512) == 55296 && i + 1 < l && (str.charCodeAt(i + 1) & 64512) == 56320) {
      c = 65536 + ((c & 1023) << 10) + (str.charCodeAt(++i) & 1023)
      v0 ^= (c >> 18) | 240
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= ((c >> 12) & 63) | 128
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= ((c >> 6) & 63) | 128
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= (c & 63) | 128
    } else {
      v0 ^= (c >> 12) | 224
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= ((c >> 6) & 63) | 128
      t0 = v0 * 435
      t1 = v1 * 435
      t2 = v2 * 435
      t3 = v3 * 435
      t2 += v0 << 8
      t3 += v1 << 8
      t1 += t0 >>> 16
      v0 = t0 & 65535
      t2 += t1 >>> 16
      v1 = t1 & 65535
      v3 = (t3 + (t2 >>> 16)) & 65535
      v2 = t2 & 65535
      v0 ^= (c & 63) | 128
    }
    t0 = v0 * 435
    t1 = v1 * 435
    t2 = v2 * 435
    t3 = v3 * 435
    t2 += v0 << 8
    t3 += v1 << 8
    t1 += t0 >>> 16
    v0 = t0 & 65535
    t2 += t1 >>> 16
    v1 = t1 & 65535
    v3 = (t3 + (t2 >>> 16)) & 65535
    v2 = t2 & 65535
  }

  return (
    hl[v3 >> 8] + hl[v3 & 255] + hl[v2 >> 8] + hl[v2 & 255] + hl[v1 >> 8] + hl[v1 & 255] + hl[v0 >> 8] + hl[v0 & 255]
  )
}

// https://github.com/cimi/murmurhash3js-revisited is a more robust fork of murmurhash3 that uses uint8 arrays instead of strings w/ chopped code points (see https://github.com/pid/murmurHash3js/issues/3#issue-364485381)
import murmur3 from 'murmurhash3js-revisited' // ~6K

// utf16 -> 32-bit integer using 32-bit murmurhash v3 algorithm, x86 variant
// optimized for x86 (32-bit) architectures
// also accepts utf8 arrays (Uint8Array)
export function hash_32_murmur3(x) {
  if (typeof x == 'string') x = encode_utf8_array(x)
  if (x.constructor.name != 'Uint8Array') throw new Error('x must be string of Uint8Array')
  return murmur3.x86.hash32(x)
}

// utf16 -> 128-bit hex string using 128-bit murmurhash v3 algorithm, x86 variant
// optimized for x86 (32-bit) architectures
// also accepts utf8 arrays (Uint8Array)
export function hash_128_murmur3_x86(x) {
  if (typeof x == 'string') x = encode_utf8_array(x)
  if (x.constructor.name != 'Uint8Array') throw new Error('x must be string of Uint8Array')
  return murmur3.x86.hash128(x)
}

// utf16 -> 128-bit hex string using 128-bit murmurhash v3 algorithm, x64 variant
// optimized for x64 (64-bit) architectures
// also accepts utf8 arrays (Uint8Array)
export function hash_128_murmur3_x64(x) {
  if (typeof x == 'string') x = encode_utf8_array(x)
  if (x.constructor.name != 'Uint8Array') throw new Error('x must be string of Uint8Array')
  return murmur3.x64.hash128(x)
}

import sha1 from 'js-sha1' // ~16K

// utf16 -> 160-bit hex string using sha1 algorithm
// also accepts utf8 arrays (Uint8Array)
export function hash_160_sha1(x) {
  if (typeof x == 'string') x = encode_utf8_array(x)
  if (x.constructor.name != 'Uint8Array') throw new Error('x must be string of Uint8Array')
  return sha1(x).hex()
}
