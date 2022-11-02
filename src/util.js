// from https://stackoverflow.com/a/2901298
export function numberWithCommas(x) {
  var parts = x.toString().split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

export function blockRegExp(type_regex) {
  if (type_regex.source) type_regex = type_regex.source // get source string if passed regex
  // sanity check against patterns that can match across multiple blocks
  if (type_regex.match(/\.[+*]/)) throw new Error(`invalid block type regex '${type_regex}' can match across blocks`)
  return new RegExp('((?:^|\\n) *)```(' + type_regex + ')\\n( *|.*?\\n *)```', 'ugsi')
}

export function extractBlock(text, type, remove_empty_lines = false) {
  // sanity check against patterns that can match across multiple blocks
  if (type.match(/\.[+*]/)) throw new Error(`invalid block type '${type}' can match across blocks`)
  // NOTE: this per-line regex is mostly consistent w/ that in updateTextDivs in Editor.svelte or toHTML in Item.svelte, and in particular allows a colon-separated prefix and suffix, w/ the suffix required to contain a period; only notable difference is that the type is allowed to match the colon-separated suffix if it matches exactly
  let insideBlock = false
  const regex = RegExp('^\\s*```(?:\\S+:)?(?:' + type + ')(?:_hidden|_removed)?(?::\\S*\\.\\S*)?(?:\\s|$)', 'ui')
  const lines = text
    .split('\n')
    .map(line => {
      if (!insideBlock) {
        if (line.match(regex)) insideBlock = true
        return
      }
      if (line.match(/^\s*```/)) {
        insideBlock = false
        return '' // for extra \n between blocks (final block delimiter is dropped below)
      }
      return line
    })
    .filter(l => l !== undefined)
  if (remove_empty_lines) _.remove(lines, l => !l || !/\S/.test(l))
  return lines.join('\n').replace(/\n$/, '') // drop \n part of final block delimiter \n```
}

export function highlight(code, language) {
  if (!window.hljs) return code
  // https://github.com/highlightjs/highlight.js/blob/master/SUPPORTED_LANGUAGES.md
  //if (language=="") return hljs.highlightAuto(code).value;
  language = language.replace(/(?:_removed|_hidden)$/, '')
  const link_urls = text =>
    text.replace(
      // url scheme regex from https://stackoverflow.com/a/190405
      // we are more restrictive on the tail (last character), disallowing common punctuation
      // we allow @ prefix due to use in stack traces in some browsers
      // consider allowing semi-colon in tail when matching in escaped html, e.g. in editor
      // (for simplicity we do not currently have a separate pattern for escaped html)
      /(^|\s|\(|@)([a-z](?:[-a-z0-9\+\.])*:\/\/[^\s)<>/]+\/?[^\s)<>:]*[^\s)<>:;,.])/gi,
      (m, pfx, href) =>
        `${pfx}<a href="${_.escape(href)}" title="${_.escape(href)}" target="_blank">${_.escape(href)}</a>`
    )
  if (language == '_log') {
    // link urls and highlight log levels in _log blocks
    return link_urls(code)
      .replace(/^(ERROR:.+?)(; STACK:|$)/gm, '<span class="console-error">$1</span>$2')
      .replace(/^(WARNING:.*)$/gm, '<span class="console-warn">$1</span>')
      .replace(/^(INFO:.*)$/gm, '<span class="console-info">$1</span>')
      .replace(/^(DEBUG:.*)$/gm, '<span class="console-debug">$1</span>')
      .replace(/(; STACK:.+)$/gm, '<span class="console-debug">$1</span>')
  } else if (language == '_output') {
    // link urls in standard _output blocks
    return link_urls(code)
  }
  // drop any _suffix if language does not start with _ (_lang is editor-only)
  if (!language.startsWith('_')) language = language.replace(/(^\w+?)_.+$/, '$1')
  // highlight json as javascript so e.g. quotes are not required for keys
  if (language == 'json') language = 'js'
  language = window.hljs.getLanguage(language) ? language : 'plaintext'
  return window.hljs.highlight(code, { language }).value
}

// string replacement helper to skip escaped matches w/o negative lookbehind (?<!\\)
// these allow _consecutive_ matches unlike prefix replacement (^|[^\\])... -> $1...
export function skipEscaped(f) {
  return function (...args) {
    // see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#specifying_a_function_as_the_replacement
    const named_groups = typeof args[args.length - 1] == 'object' ? args.pop() : undefined
    const string = args.pop()
    const offset = args.pop()
    const [match, ...groups] = args
    if (string[offset - 1] == '\\') return match // escaped case, skip replacement
    if (typeof f == 'function') return f(match, ...groups, offset, string, named_groups)
    return f // return f as is
  }
}

// single tag regex
// allowed characters are extensive, well outside of [\p{L}\d/_-]
// some examples of characters found useful in tags are: ⇧⏎²… and θμσ…
// there is no trailing delimiter, which would be simply the inverse of allowed chars
// tag patterns matching _specific_ tags should use the inverse as trailing delimiter for consistency
// this is done automatically in replaceTags below, but other functions can use tagRegexDelimiter
export const tagRegex = /^#[^#\s<>&\?!,.;:"'`(){}\[\]]+$/

// regex alternation string of "exclusions" (e.g. ex1|ex2|...) to be used as prefix <exclusions>|<tag_regex>
// filter out exclusions by using capture groups and checking if first group (e.g. pfx) is undefined
// this particular set of exclusions should be consistent w/ parseTags below
// assumes flags gs for multiple & multi-line matching (use [^\n]* instead of .* to simulate single-line matching)
// exclusions can NOT contain capture groups since it is useless and prohibits simple filtering via undefined captures
// exclusions currently miss indented block lines that starts w/ bullets (since it requires context to parse correctly)
export const tagRegexExclusions = [
  '(?:^|\\n) *```.*?\\n *```', // multi-line block
  '(?:^|\\n)     *[^-*+ ][^\\n]*(?:$|\\n)', // 4-space indented block
  '`[^\\n]*?`', // inline code spans
  '\\$?\\$`[^\\n]+?`\\$\\$?', // math
  '<script.*?>.*?</script>', // scripts
  '<style>.*?</style>', // styles
  '</?\\w(?:"[^"]*"|[^>"])*?>', // html tags
  '<!--.*?-->', // html comment tags
  '<<[^\\n]*?>>', // macros
  '@{[^\\n]*?}@', // eval macros
].join('|')

export const tagRegexExclusionsEscaped = [
  '(?:^|\\n) *```.*?\\n *```', // multi-line block
  '(?:^|\\n)     *[^-*+ ][^\\n]*(?:$|\\n)', // 4-space indented block
  '`[^\\n]*?`', // inline code spans
  '\\$?\\$`[^\\n]+?`\\$\\$?', // math
  '&lt;script.*?&gt;.*?&lt;/script&gt;', // scripts
  '&lt;style.*?&gt;.*?&lt;/style&gt;', // styles
  '&lt;/?\\w(?:&quot;(?:(?!&quot;).)*&quot;|(?!&gt;|&quot;).)*?&gt;', // html tags (escaped)
  '&lt;!--.*?--&gt;', // html comment tags
  '&lt;&lt;[^\\n]*?&gt;&gt;', // macros
  '@{[^\\n]*?}@', // eval macros
].join('|')

export const tagRegexDelimiter = /(?=[\s<>&\?!,.;:"'`(){}\[\]]|$)/.source // inverse of tag pattern in parseTags below
export const tagRegexDelimiterEscaped = /(?=[\s\?!,.;:`(){}\[\]]|&lt;|&gt;|&amp;|&quot;|&#39;|$)/.source

export function replaceTags(text, tagRegex, replacer, escaped) {
  if (tagRegex.source) tagRegex = tagRegex.source // get string representation
  tagRegex =
    (escaped ? tagRegexExclusionsEscaped : tagRegexExclusions) +
    '|()' + // used to filter out exclusions in wrapper function below
    tagRegex +
    (escaped ? tagRegexDelimiterEscaped : tagRegexDelimiter)
  return text.replace(new RegExp(tagRegex, 'gs'), function (m, pfx, ...args) {
    if (pfx === undefined) return m // skip exclusions
    return replacer(m, ...args) // apply replacer
  })
}

export function parseTags(text) {
  const regex = new RegExp(tagRegexExclusions + '|(?:^|\\s|\\()(' + tagRegex.source.slice(1, -1) + ')', 'gs')
  const uniq_tags = new Set()
  for (const m of text.matchAll(regex)) if (m[1]) uniq_tags.add(m[1])
  const tags = Array.from(uniq_tags)
  return {
    raw: tags,
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

export function countUnescaped(str, substr) {
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
  if (countUnescaped(expr, '`') % 2 || countUnescaped(expr, "'") % 2 || countUnescaped(expr, '"') % 2) return false
  expr = expr.replace(/`.*?`|'[^\n]*?'|"[^\n]*?"/gs, '') // avoid matching inside strings
  // NOTE: */ can be confused w/ ending of regex so we allow mismatch if / are even (not fool-proof but should be good enough for now)
  if (countUnescaped(expr, '/*') != countUnescaped(expr, '*/') && countUnescaped(expr, '/') % 2) return false
  expr = expr.replace(/\/\/[^\n]*|\/\*.*?\*\//gs, '') // avoid matching inside comments
  if (
    countUnescaped(expr, '{') != countUnescaped(expr, '}') ||
    countUnescaped(expr, '[') != countUnescaped(expr, ']') ||
    countUnescaped(expr, '(') != countUnescaped(expr, ')')
  )
    return false
  return true
}

// NOTE: element cache invalidation should be triggered on any script/eval errors, but also whenever an item is run or <script>s executed since code dependencies can never be fully captured in cache keys (even with deephash)
export function invalidateElemCache(id) {
  // console.warn('invalidateElemCache for ', id)
  window['_elem_cache']?.[id]?.forEach(elem => {
    const key = elem.getAttribute('_cache_key')
    // we allow some items to skip invalidation, e.g. to be intentionally reused across runs
    if (elem.hasAttribute('_skip_invalidation')) return
    // console.warn('deleting from _elem_cache', key)
    window['_elem_cache'][id].delete(key)
    // destroy all children and SELF w/ _destroy attribute (and property)
    elem.querySelectorAll('[_destroy]').forEach(e => e['_destroy']())
    elem._destroy?.()
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
    window['_elem_cache'][id]?.forEach(elem => {
      if (document.contains(elem)) return // elem is already on the page
      const key = elem.getAttribute('_cache_key')
      // console.warn("orphaned cached element", key, "from item", window["_item"](id).name);
      // if element has zero-width, destroy it, otherwise adopt it
      if (elem.offsetWidth == 0) {
        window['_elem_cache'][id].delete(key)
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

// convert byte array (Uint8Array) -> byte string of code points <=255 (a.k.a. a "binary string")
// based on https://stackoverflow.com/a/20604561
export function byteArrayToString(array) {
  if (array.constructor.name != 'Uint8Array') throw new Error('invalid argument, expected Uint8Array')
  const len = array.length
  const inc = 65535 // max args, see https://stackoverflow.com/a/22747272
  let str = ''
  for (let i = 0; i < len; i += inc) str += String.fromCharCode.apply(null, array.subarray(i, Math.min(len, i + inc)))
  return str
}

// convert byte string -> byte array (Uint8Array), ensuring code points <= 255
// note this is much faster than Uint8Array.from despite checking each code point
export function byteStringToArray(str) {
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

// concatenate pair of Uint8Arrays
export function concatByteArrays(arr1, arr2) {
  if (arr1.constructor.name != 'Uint8Array' || arr2.constructor.name != 'Uint8Array')
    throw new Error('invalid arguments, expected pair of Uint8Arrays')
  const array = new Uint8Array(arr1.length + arr2.length)
  array.set(arr1)
  array.set(arr2, arr1.length)
  return array
}

// converts x to a string
// mainly uses JSON.stringify
// only exceptions are:
//  - undefined & null, returned as strings 'undefined' or 'null'
//  - non-Object non-Array objects, handled recursively via _.entries
//  - functions, handled using toString + any enumarable properties/values
export function stringify(x) {
  if (x === undefined) return 'undefined' // can not be parsed back
  if (x === null) return 'null'
  if (x.constructor.name == 'ArrayBuffer' || ArrayBuffer.isView(x))
    return _stringify_object(x) + ` (${x.byteLength} bytes)`
  if (typeof x == 'object' && x.constructor.name != 'Object' && !Array.isArray(x)) return _stringify_object(x)
  if (typeof x == 'function')
    return _unindent(x.toString().replace(/^\(\)\s*=>\s*/, '')) + (_.keys(x).length ? ' ' + _stringify_object(x) : '')
  const json = JSON.stringify(x)
  if (json) return json
  return `[${typeof x} ${x.constructor.name} ${x}]` // ultimate fallback
}

// converts ArrayBuffer & views to byte string (code points <=255) via byteArrayToString
export function byte_stringify(x) {
  if (x.constructor.name == 'ArrayBuffer') return byteArrayToString(new Uint8Array(x))
  if (ArrayBuffer.isView(x)) {
    if (x.buffer?.constructor.name != 'ArrayBuffer') throw new Error('invalid ArrayBuffer view w/o buffer property')
    return byteArrayToString(new Uint8Array(x.buffer))
  }
  throw new Error('invalid argument, expected ArrayBuffer or view (e.g. Uint8Array)')
}

function _stringify_object(x) {
  return [
    x.constructor.name != 'Object' ? `[${typeof x} ${x.constructor.name}]` : '',
    '{',
    // _.entries uses .entries() for maps
    _.entries(x)
      .map(([k, v]) => `${k}:${stringify(v)}`)
      .join(' '),
    '}',
  ]
    .join(' ')
    .replace('{  }', '')
    .trim()
}

function _unindent(fstr) {
  const indent_match = fstr.match(/\n( +)\} *$/)
  if (!indent_match) return fstr
  const indent = indent_match[0]
  if (indent) fstr = fstr.replace(new RegExp(`^${indent}`, 'gm'), '')
  return fstr
}

// encodes string (utf-16) into encoded string/array
export function encode(str, encoding = 'base64') {
  if (typeof str != 'string') throw new Error('can not encode non-string')
  switch (encoding.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return encode_utf8(str)

    case 'utf8_array':
    case 'utf8-array':
    case 'utf-8_array':
    case 'utf-8-array':
      return encode_utf8_array(str)

    case 'byte_array':
    case 'byte-array':
      return encode_byte_array(str)

    case 'base64':
    case 'base-64':
    case 'b64':
      return encode_base64(str)

    default:
      throw new Error(`encode: unknown encoding '${encoding}'`)
  }
}

// decodes string (utf-16) from encoded string/array
export function decode(encoded, encoding = 'base64') {
  switch (encoding.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return decode_utf8(encoded)

    case 'utf8_array':
    case 'utf8-array':
    case 'utf-8_array':
    case 'utf-8-array':
      return decode_utf8_array(encoded)

    case 'byte_array':
    case 'byte-array':
      return decode_byte_array(encoded)

    case 'base64':
    case 'base-64':
    case 'b64':
      return decode_base64(encoded)

    default:
      throw new Error(`decode: unknown encoding '${encoding}'`)
  }
}

import utf8 from '../node_modules/utf8' // ~18K

// utf16 -> utf8
export function encode_utf8(str) {
  return utf8.encode(str)
}

// utf8 -> utf16
export function decode_utf8(utf8_str) {
  return utf8.decode(utf8_str)
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

// utf16 -> byte array (Uint8Array), for code points <=255 only
export function encode_byte_array(str) {
  return byteStringToArray(str)
}

// byte array (Uint8Array) -> utf16 using only code points <=255
export function decode_byte_array(array) {
  return byteArrayToString(array)
}

// utf16 -> base64(ascii)
export function encode_base64(str) {
  return btoa(utf8.encode(str))
}

// base64(ascii) -> utf16
export function decode_base64(base64) {
  return utf8.decode(atob(base64))
}

// generic hasher that handles non-strings
// hash of undefined is undefined, but null is hashed (as object)
// default hasher is hash_64_fnv1a, returns 64-bit hex string
// default stringifier is:
//  - byte_stringify (above) for ArrayBuffer & views
//  - stringify (also above) for functions
//  - JSON.stringify for everything else
export function hash(x, hasher, stringifier) {
  if (typeof x == 'undefined') return undefined
  if (typeof x != 'string') {
    if (stringifier) x = stringifier(x)
    else if (typeof x == 'function') x = stringify(x)
    else if (x.constructor.name == 'ArrayBuffer' || ArrayBuffer.isView(x)) x = byte_stringify(x)
    else x = JSON.stringify(x)
  }
  if (hasher) return hasher(x)
  return hash_64_fnv1a(x)
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
// import fnv1a from '../node_modules/fnv-plus'

// utf16 -> 32-bit integer using fnv-1a algorithm
// _hash32_1a_fast_utf from https://github.com/tjwebb/fnv-plus/blob/1e2ce68a07cb7dd4c3c85364f3d8d96c95919474/index.js#L341
export function hash_32_fnv1a(str) {
  let c,
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
  let c,
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
  let c,
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
import murmur3 from '../node_modules/murmurhash3js-revisited' // ~6K

// utf16 -> 32-bit integer using 32-bit murmurhash v3 algorithm, x86 variant
// optimized for x86 (32-bit) architectures
// also accepts utf8 arrays (Uint8Array)
export function hash_32_murmur3(x) {
  if (typeof x == 'string') x = encode_utf8_array(x)
  if (x.constructor.name != 'Uint8Array') throw new Error('x must be Uint8Array')
  return murmur3.x86.hash32(x)
}

// utf16 -> 128-bit hex string using 128-bit murmurhash v3 algorithm, x86 variant
// optimized for x86 (32-bit) architectures
// also accepts utf8 arrays (Uint8Array)
export function hash_128_murmur3_x86(x) {
  if (typeof x == 'string') x = encode_utf8_array(x)
  if (x.constructor.name != 'Uint8Array') throw new Error('x must be Uint8Array')
  return murmur3.x86.hash128(x)
}

// utf16 -> 128-bit hex string using 128-bit murmurhash v3 algorithm, x64 variant
// optimized for x64 (64-bit) architectures
// also accepts utf8 arrays (Uint8Array)
export function hash_128_murmur3_x64(x) {
  if (typeof x == 'string') x = encode_utf8_array(x)
  if (x.constructor.name != 'Uint8Array') throw new Error('x must be Uint8Array')
  return murmur3.x64.hash128(x)
}

import sha1 from '../node_modules/js-sha1' // ~16K

// utf16 -> 160-bit hex string using sha1 algorithm
// also accepts utf8 arrays (Uint8Array)
export function hash_160_sha1(x) {
  if (typeof x == 'string') x = encode_utf8_array(x)
  if (x.constructor.name != 'Uint8Array') throw new Error('x must be Uint8Array')
  return sha1.hex(x)
}
