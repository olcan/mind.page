// INERT MATH (the owner's ask of 2026-10-04; reviews 0-2 of the inert_math slice): an inert
// frame's math (a bridge reply's `span.math` and `span.math-display`, src/inert_markdown.ts) is
// typeset by a MathJax document OF THE FRAME'S OWN, built here for the frame and dropped after
// it, never by the page's document the owner's math goes through:
// - a PLAIN document (the handler class the page registers, without the page's menu, assistive
//   and other mixins: a frame's math has no context menu, and no menu callback of a frame can
//   recreate the page's document, review 2 R2) with a new TeX input jax per frame (no
//   definition, operator, label or color of one frame reaches another frame or the owner's
//   parser; within the frame they hold) over a BOUNDED package set (INERT_PACKAGES: the page's
//   TeX without `autoload`, `require` and `configmacros`, plus common extensions; not `unicode`,
//   whose font choices live in a module-level cache every parser shares, review 2 R3). A reply's
//   TeX can select no load of its own: a load is what breaks isolation (MathJax's `autoload`
//   keeps one module-level table of the macros that load an extension and strikes a macro from
//   it when any parser loads the extension, registering the package with that parser alone, so a
//   second autoloading parser cripples the first: review 1's detour) and what the lanes' vendor
//   gate refuses; `\require` and `\unicode` are undefined macros here (`noundefined`: shown in red);
// - this module's own filter of the frame's MathML, a post-filter on the frame's input jax (as
//   MathJax's safe extension hooks its own; that extension is not loaded: its handler extension
//   is global and would reach the page's document on a recreation, review 2 R2). `href`, `src`
//   and `altimg` (an anchor or an image the frame's rules never admitted), `class`, `id` and
//   `style` (a model's CSS, review 0 B1), `fontfamily`, `fontweight` and `fontstyle` (`\mmlToken`
//   takes any string there, and the output wrapper serializes them into a `style` attribute: review
//   3 R1; TeX's own font commands go through MathJax's variants and need none of them), `xmlns` and
//   every `data-` attribute but MathJax's own are dropped; the color attributes (`\color`, `\textcolor`, `\colorbox`, `\bbox[color]`,
//   `\mmlToken[color]`) keep a name, a hex or a functional notation and lose anything else (a
//   `url(…)` the SVG output would carry into `fill` and `stroke`, review 1 R4); the size
//   attributes keep a value within this module's bounds (a length up to 3 em, so a frame's
//   `\Huge` at 2.49 em holds; a script size multiplier within [0.6, 1]; a script level within
//   [-2, 2]: the safe extension's generic bounds, its font-size range of [0.707, 1.44] not
//   adopted) and lose anything else. A formula's own dimensions are not bounded (a long one, or
//   a `\rule`, overflows its frame as the owner's would);
// - the frame's extensions are loaded once, lazily, at the first frame with math, after the
//   page's startup (`MathJax.startup.promise`; the page's own automatic typesetting is off in
//   src/app.html and the caller waits for the startup too, so no startup scan ever sees a frame's
//   math: review 2 R1). A load that fails fails this frame, and every later one until the page
//   reloads: MathJax keeps a rejected package promise (`shared` is reset for the retry, which
//   then rejects again);
// - a failure leaves the frame's document behind with its unfinished items, which no later
//   typeset can resume (the page's `typesetPromise` sees only the page's document: review 1 R1);
//   the caller marks the spans and lets the item count as rendered.
// The output jax is the page's document's current one (it holds no parser state and one
// stylesheet, and follows a renderer switch in the owner's menu; it keeps a reference to the
// last document it served until the next one, so a frame's document lives that long). The MathJax
// 3.1.2 surface used here: `MathJax.startup.promise`, `MathJax.loader.load`, `MathJax.startup
// .constructors.tex` and `.HTMLHandler` (the registry the startup's own factories instantiate
// from), `MathJax.startup.adaptor` and `.document.outputJax`, `handler.create(document, options)`, a TeX
// jax's `postFilters` with the parse options' `root` (how the safe extension hooks in),
// `MmlNode.walkTree` and `attributes.getAllAttributes()`, `MathJax._.mathjax.mathjax
// .handleRetriesFor`, `options.elements` set after construction as the startup's own
// `typesetPromise` sets it. The bridge e2e rows (tests/e2e/bridge.spec.ts) assert the forms, the
// dropped and kept attributes, a frame's definitions against the next frame and the owner, the
// owner's untouched sizing and anchor, a frame's math present before the startup, a failed load
// and a failed construction.

const INERT_PACKAGES = ['base', 'ams', 'newcommand', 'noundefined', 'color', 'html', 'boldsymbol', 'cancel', 'bbox', 'enclose', 'mhchem', 'verb']
// the extensions of INERT_PACKAGES the page does not load itself ([tex]/color is the page's)
const INERT_EXTENSIONS = ['[tex]/html', '[tex]/boldsymbol', '[tex]/cancel', '[tex]/bbox', '[tex]/enclose', '[tex]/mhchem', '[tex]/verb']

const DROPPED = new Set(['href', 'src', 'altimg', 'class', 'id', 'style', 'fontfamily', 'fontweight', 'fontstyle', 'xmlns'])
const COLORS = new Set(['mathcolor', 'mathbackground', 'color', 'background'])
// a color MathJax may carry into fill, stroke or a background rect: a name, a hex, a functional notation
const COLOR = /^\s*(?:[a-zA-Z]+|#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\(\s*[0-9.%\s,/-]*\))\s*$/
const LENGTHS = new Set(['mathsize', 'fontsize', 'scriptminsize'])
// a length within 3 em: MathML's named sizes, or a number with a unit (em, ex, %, px, pt, or none; MathJax's
// conversions: 1 pt = 0.1 em, 1 px = 1/16 em, 1 ex = 0.431 em)
const LENGTH = /^\s*(?:(small|normal|big)|(\d+(?:\.\d*)?|\.\d+)\s*(em|ex|%|px|pt|))\s*$/
const EM_PER_UNIT: Record<string, number> = { em: 1, ex: 0.431, '%': 0.01, px: 1 / 16, pt: 0.1, '': 1 }
const LENGTH_MAX = 3

function boundedLength(value: string): boolean {
  const m = LENGTH.exec(value)
  if (!m) return false
  if (m[1]) return true
  return parseFloat(m[2]) * EM_PER_UNIT[m[3]] <= LENGTH_MAX
}

// the frame's MathML, attribute by attribute (the attributes object is the node's own, as MathJax's
// safe extension edits it)
function sanitize(node: any): void {
  const attributes = node.attributes.getAllAttributes()
  for (const name of Object.keys(attributes)) {
    const value = String(attributes[name])
    let keep = true
    if (DROPPED.has(name) || (name.startsWith('data-') && !name.startsWith('data-mjx-'))) keep = false
    else if (COLORS.has(name)) keep = COLOR.test(value)
    else if (LENGTHS.has(name)) keep = boundedLength(value)
    else if (name === 'scriptsizemultiplier') keep = parseFloat(value) >= 0.6 && parseFloat(value) <= 1
    else if (name === 'scriptlevel') keep = /^\s*[-+]?\d+\s*$/.test(value) && Math.abs(parseInt(value, 10)) <= 2
    if (!keep) delete attributes[name]
  }
}

let shared: Promise<any> | null = null // the frames' plain handler, once the page's startup and the extensions' load are done
function prepare(): Promise<any> {
  if (!shared) {
    const MathJax = (window as any).MathJax
    shared = MathJax.startup.promise
      .then(() => MathJax.loader.load(...INERT_EXTENSIONS))
      .then(
        () => new MathJax.startup.constructors.HTMLHandler(MathJax.startup.adaptor),
        (error: unknown) => {
          shared = null
          throw error
        }
      )
  }
  return shared!
}

export async function typesetInertMath(elems: Element[]): Promise<void> {
  if (!elems.length) return
  const MathJax = (window as any).MathJax
  const handler = await prepare()
  const input = new MathJax.startup.constructors.tex({ ...MathJax.config.tex, packages: INERT_PACKAGES })
  input.postFilters.add((args: any) => void args.data.root.walkTree(sanitize), -5.5)
  const doc = handler.create(document, { InputJax: input, OutputJax: MathJax.startup.document.outputJax })
  doc.options.elements = elems
  await MathJax._.mathjax.mathjax.handleRetriesFor(() => doc.render())
}
