<script lang="ts">
  export let id = "editor";
  export let text = "";
  export let focused = false;
  export let cancelOnDelete = false;
  export let allowCommandBracket = false;
  export let onFocused = (focused: boolean) => {};
  export let onChange = (text) => {};
  export let onDone = (
    text: string,
    cancelled: boolean = false,
    run: boolean = false
  ) => {};
  export let onRun = () => {};
  export let onPrev = () => {};
  export let onNext = () => {};

  const placeholder = " ";
  let editor: HTMLDivElement;
  let backdrop: HTMLDivElement;
  let highlights: HTMLDivElement;
  let textarea: HTMLTextAreaElement;
  // NOTE: we omit the semicolon as it is optional and simplifies regex for tags which otherwise split at semicolons
  let escapeHTML = (t) => t.replace(/</g, "&lt").replace(/>/g, "&gt");
  // TODO: refactor regex for tag matching (contains [^#...])
  let highlightTags = (t) =>
    t.replace(/(^|\s|;)(#[^#\s<>,.;:"'`\(\)\[\]\{\}]+)/g, "$1<mark>$2</mark>");
  let highlightCode = (t) =>
    t.replace(/(`.*?`)/g, '<span class="code">$1</span>');
  let highlightMath = (t) =>
    t.replace(/(\$\$?.+?\$\$?)/g, '<span class="math">$1</span>');

  import { highlight } from "../util.js";

  function findMatchingOpenParenthesis(text, pos) {
    let close = text[pos];
    let open;
    switch (close) {
      case ")":
        open = "(";
        break;
      case "]":
        open = "[";
        break;
      case "}":
        open = "{";
        break;
    }
    let closed = 1;
    while (closed > 0 && pos >= 0) {
      pos--;
      if (text[pos] == open) closed--;
      else if (text[pos] == close) closed++;
    }
    return pos;
  }

  function findMatchingCloseParenthesis(text, pos) {
    let open = text[pos];
    let close;
    switch (open) {
      case "(":
        close = ")";
        break;
      case "[":
        close = "]";
        break;
      case "{":
        close = "}";
        break;
    }
    let opened = 1;
    while (opened > 0 && pos < text.length) {
      pos++;
      if (text[pos] == close) opened--;
      else if (text[pos] == open) opened++;
    }
    return pos;
  }

  function highlightPosition(text, pos, type) {
    return (
      text.substring(0, pos) +
      `__highlight_${type}_${text[pos]}__` +
      text.substring(pos + 1)
    );
  }

  function updateTextDivs() {
    let text = textarea.value || placeholder;

    // pre-highlight matching parentheses using special syntax processed below
    if (
      textarea.selectionStart == textarea.selectionEnd &&
      textarea.selectionStart > 0 &&
      textarea.selectionStart < text.length &&
      ")]}".indexOf(text[textarea.selectionStart]) >= 0
    ) {
      let matchpos = findMatchingOpenParenthesis(text, textarea.selectionStart);
      if (matchpos >= 0) {
        text = highlightPosition(text, textarea.selectionStart, "matched");
        text = highlightPosition(text, matchpos, "matched");
      } else {
        text = highlightPosition(text, textarea.selectionStart, "unmatched");
      }
    }
    if (
      textarea.selectionStart == textarea.selectionEnd &&
      textarea.selectionStart > 0 &&
      textarea.selectionStart < text.length &&
      "([{".indexOf(text[textarea.selectionStart - 1]) >= 0
    ) {
      let matchpos = findMatchingCloseParenthesis(
        text,
        textarea.selectionStart - 1
      );
      if (matchpos < text.length) {
        text = highlightPosition(text, matchpos, "matched");
        text = highlightPosition(text, textarea.selectionStart - 1, "matched");
      } else {
        text = highlightPosition(
          text,
          textarea.selectionStart - 1,
          "unmatched"
        );
      }
    }

    let insideBlock = false;
    let language = "";
    let code = "";
    let html = "";
    text.split("\n").map((line) => {
      if (!insideBlock && line.match(/^\s*```(\w*)$/)) {
        insideBlock = true;
        language = line.match(/^\s*```(\w*)$/).pop();
        code = "";
        html += '<span class="block-delimiter">';
        html += escapeHTML(line);
        html += "</span>\n";
      } else if (insideBlock && line.match(/^\s*```/)) {
        html += '<div class="block">';
        html += highlight(code, language);
        html += "</div>";
        insideBlock = false;
        html += '<span class="block-delimiter">';
        html += escapeHTML(line);
        html += "</span>\n";
      } else if (insideBlock) {
        code += line + "\n";
      } else {
        if (line.match(/^    \s*[^-*]/)) html += line + "\n";
        else
          html +=
            highlightMath(highlightCode(highlightTags(escapeHTML(line)))) +
            "\n";
      }
    });
    // append unclosed block as regular markdown
    if (insideBlock)
      html += highlightMath(highlightCode(highlightTags(escapeHTML(code))));

    // wrap hidden/removed sections
    html = html.replace(
      /(^|\n\s*?)(&lt!--\s*?hidden\s*?--&gt.+?&lt!--\s*?\/hidden\s*?--&gt\s*?\n)/gs,
      '$1<div class="section hidden">$2</div>'
    );
    html = html.replace(
      /(^|\n\s*?)(&lt!--\s*?removed\s*?--&gt.+?&lt!--\s*?\/removed\s*?--&gt\s*?\n)/gs,
      '$1<div class="section removed">$2</div>'
    );
    // indicate section delimiters
    html = html.replace(
      /(&lt!--\s*?\/?(?:hidden|removed)\s*?--&gt)/g,
      '<span class="section-delimiter">$1</span>'
    );
    // convert special highlight syntax into spans
    html = html.replace(
      /__highlight_(\w+?)_(.+?)__/g,
      '<span class="highlight $1">$2</span>'
    );

    highlights.innerHTML = html;
    textarea.style.height = editor.style.height = backdrop.scrollHeight + "px";
  }

  let enterStart = -1;
  let enterIndentation = "";
  function onKeyDown(e: KeyboardEvent) {
    // console.debug(e);
    // https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code/code_values

    if (
      !allowCommandBracket &&
      (e.code == "BracketLeft" || e.code == "BracketRight") &&
      e.metaKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // indent/comment selection or current line
    if (
      ((e.code == "BracketLeft" || e.code == "BracketRight") && e.ctrlKey) ||
      (e.code == "Tab" && textarea.selectionEnd > textarea.selectionStart) ||
      (e.code == "Slash" && e.ctrlKey)
    ) {
      e.preventDefault();
      e.stopPropagation(); // do not propagate to window
      const oldStart = textarea.selectionStart;
      let oldEnd = textarea.selectionEnd;
      let oldLength = textarea.value.length;
      // move selection to line start
      let lineStart = textarea.value
        .substring(0, textarea.selectionStart)
        .replace(/[^\n]*$/, "").length;
      if (
        textarea.selectionStart == textarea.selectionEnd &&
        e.code == "BracketRight"
      ) {
        textarea.selectionStart = textarea.selectionEnd = lineStart;
      } else {
        textarea.selectionStart = lineStart;
      }
      // expand selection to end of last line
      // if selection ends right after a new line, exclude the last line
      if (
        textarea.selectionEnd > textarea.selectionStart &&
        textarea.value[textarea.selectionEnd - 1] == "\n"
      )
        textarea.selectionEnd--;
      let lastLineStart = textarea.value
        .substring(0, textarea.selectionEnd)
        .replace(/[^\n]*$/, "").length;
      let lineEnd =
        lastLineStart +
        textarea.value
          .substring(lastLineStart)
          .match(/^[^\n]*/)[0]
          .trimEnd().length;
      textarea.selectionEnd = lineEnd;

      // NOTE: execCommand maintains undo/redo history
      let selectedText = textarea.value.substring(
        textarea.selectionStart,
        textarea.selectionEnd
      );
      document.execCommand(
        "insertText",
        false,
        e.code == "Slash"
          ? selectedText.match(/^\s*\/\//) // match(/(^|\n)\s*\/\//)
            ? selectedText.replace(/((?:^|\n)\s*)\/\/\s*/g, "$1")
            : selectedText.replace(/((?:^|\n)\s*)(.*)/g, "$1// $2")
          : e.code == "BracketLeft" || (e.code == "Tab" && e.shiftKey)
          ? selectedText.replace(/(^|\n)  /g, "$1")
          : selectedText.replace(/(^|\n)/g, "$1  ")
      );

      if (oldStart < oldEnd) {
        // restore expanded selection
        textarea.selectionStart = Math.min(lineStart, oldStart);
        textarea.selectionEnd = oldEnd + (textarea.value.length - oldLength);
      } else {
        // move forward
        textarea.selectionStart = textarea.selectionEnd = Math.max(
          lineStart,
          oldEnd + (textarea.value.length - oldLength)
        );
      }
      onInput();
      return;
    }

    if (textarea.selectionStart != textarea.selectionEnd) return; // we do not handle selection below here

    // create line on Enter, maintain indentation
    // NOTE: to prevent delay on caret update, we do the actual indentation in onKeyUp
    if (
      e.code == "Enter" &&
      !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)
    ) {
      if (enterStart < 0) {
        enterStart = textarea.selectionStart;
        enterIndentation =
          textarea.value
            .substring(0, textarea.selectionStart)
            .match(/(?:^|\n)( *).*?$/)[1] || "";
      }
      return;
    }

    // navigate to prev/next item by handling arrow keys (without modifiers) that go out of bounds
    if (!(e.shiftKey || e.metaKey || e.ctrlKey)) {
      if (
        (e.code == "ArrowUp" || e.code == "ArrowLeft") &&
        textarea.selectionStart == 0
      ) {
        e.stopPropagation();
        e.preventDefault();
        onPrev();
        return;
      }
      if (
        (e.code == "ArrowDown" || e.code == "ArrowRight") &&
        textarea.selectionStart == textarea.value.length
      ) {
        e.stopPropagation();
        e.preventDefault();
        onNext();
        return;
      }
    }

    // remove spaced tabs with backspace
    // (for backspace, unlike shift-tab, we require/allow an _extra_ space and we require even number of spaces)
    if (
      e.code == "Backspace" &&
      !(e.shiftKey || e.metaKey || e.ctrlKey) &&
      textarea.selectionStart >= 3 &&
      textarea.value
        .substring(textarea.selectionStart - 3, textarea.selectionStart)
        .match(/\s  /) &&
      !(
        textarea.value.substring(0, textarea.selectionStart).match(/ +$/)[0]
          .length % 2
      )
    ) {
      textarea.selectionStart = textarea.selectionStart - 2;
      document.execCommand("delete", false);
      e.preventDefault();
      onInput();
      return;
    }

    // delete empty item with backspace
    if (
      e.code == "Backspace" &&
      textarea.value.trim() == "" &&
      textarea.selectionStart == 0
    ) {
      onDone((text = ""), cancelOnDelete); // if cancelled, item will not be deleted
      e.preventDefault();
      return;
    }

    // cancel edit with escape
    if (e.code == "Escape") {
      onDone(text /* maintain text */, true /* cancelled */);
      e.preventDefault();
      return;
    }

    // clear item (from current position to start) with shift-backspace
    if (e.code == "Backspace" && e.shiftKey) {
      textarea.selectionStart = 0;
      document.execCommand("delete", false);
      e.preventDefault();
      onInput();
      return;
    }

    // delete non-empty item with Cmd/Ctrl+Backspace
    // NOTE: Cmd-Backspace may be assigned already to "delete line" and overload requires disabling on key down
    if (e.code == "Backspace" && (e.metaKey || e.ctrlKey)) {
      onDone((text = ""), cancelOnDelete); // if cancelled, item will not be deleted
      e.preventDefault();
      return;
    }

    // insert spaces on Tab
    if (e.code == "Tab") {
      e.preventDefault();
      if (!e.shiftKey) {
        // forward tab
        document.execCommand("insertText", false, "  ");
      } else if (
        textarea.selectionStart >= 2 &&
        textarea.value.substring(
          textarea.selectionStart - 2,
          textarea.selectionStart
        ) == "  "
      ) {
        textarea.selectionStart = textarea.selectionStart - 2;
        document.execCommand("delete", false);
      }
      onInput();
      return;
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    // indent lines created by Enter (based on state recorded in onKeyDown above)
    if (
      e.code == "Enter" &&
      !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)
    ) {
      if (enterStart >= 0) {
        // extend bullet points to new lines
        const bullet = textarea.value
          .substring(0, enterStart)
          .match(/(?:^|\n) *([-*] ).*$/);
        if (bullet) enterIndentation += bullet[1];
        if (enterIndentation) {
          let newlines = textarea.value.substring(
            enterStart,
            textarea.selectionEnd
          );
          newlines = newlines.replace(/\n/g, "\n" + enterIndentation);
          textarea.selectionStart = enterStart;
          document.execCommand("insertText", false, newlines);
          onInput();
        }
        enterStart = -1;
        enterIndentation = "";
      }
    }
  }

  function onKeyPress(e: KeyboardEvent) {
    // console.debug(e);
    // add/save item with Cmd/Ctrl+S or Shift/Cmd/Ctrl+Enter
    if (
      (e.code == "Enter" && e.shiftKey && !(e.metaKey || e.ctrlKey)) ||
      (e.code == "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) ||
      (e.code == "KeyS" && (e.metaKey || e.ctrlKey) && !e.shiftKey)
    ) {
      e.preventDefault();
      e.stopPropagation(); // do not propagate to window
      onDone(
        (text = textarea.value),
        false,
        e.code == "Enter" && (e.metaKey || e.ctrlKey) /*run*/
      );
      return;
    }
    // run item with Alt/Option+Enter
    if (e.code == "Enter" && e.altKey) {
      e.preventDefault();
      e.stopPropagation(); // do not propagate to window
      let selection = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };
      onRun();
      setTimeout(() => {
        textarea.selectionStart = selection.start;
        textarea.selectionEnd = selection.end;
      }, 0);
      return;
    }
  }

  function onInput() {
    // force replace tabs with spaces
    if (textarea.value.indexOf("\t") >= 0) {
      // if tabbed line is preceded by a bullet, convert all tabs to indented bullets (e.g. for MindNode import)
      let bullet;
      if ((bullet = textarea.value.match(/(?:^|\n) *([-*] ).*\n?.*\t/)))
        textarea.value = textarea.value.replace(/(\t+)/g, "$1" + bullet[1]);
      textarea.value = textarea.value.replace(/\t/g, "  ");
    }
    text = textarea.value; // no trimming until onDone
    updateTextDivs();
    onChange(textarea.value);
  }

  import { afterUpdate, onMount, onDestroy } from "svelte";
  afterUpdate(updateTextDivs);

  const selectionUpdateDebounceTime = 250;
  let selectionUpdatePending = false;
  function onSelectionChange(e) {
    if (!document.activeElement.isSameNode(textarea)) return;
    if (textarea.selectionStart != textarea.selectionEnd) return;
    if (selectionUpdatePending) return;
    selectionUpdatePending = true;
    setTimeout(() => {
      selectionUpdatePending = false;
      if (
        highlights.querySelector("span.highlight") ||
        (textarea.selectionStart > 0 &&
          textarea.selectionStart < text.length &&
          ")]}".indexOf(textarea.value[textarea.selectionStart]) >= 0) ||
        (textarea.selectionStart > 0 &&
          textarea.selectionStart < text.length &&
          "([{".indexOf(textarea.value[textarea.selectionStart - 1]) >= 0)
      ) {
        updateTextDivs();
      }
    }, selectionUpdateDebounceTime);
  }
  onMount(() =>
    document.addEventListener("selectionchange", onSelectionChange)
  );
  onDestroy(() =>
    document.removeEventListener("selectionchange", onSelectionChange)
  );
</script>

<style>
  .editor {
    position: relative;
    width: 100%;
    cursor: text;
    padding-bottom: 2px; /* covers extra 2px of backdrop (see below), aligns correctly if item has outer border */
    caret-color: red;
  }
  .backdrop,
  textarea {
    font-family: monospace;
    font-size: 15px;
    line-height: 24px;
  }
  .backdrop {
    /* color: transparent; */
    color: #ddd;
    position: absolute;
    /* top: -1px; */ /* NOTE: backdrop is 2px taller (perhaps due to border) but aligns correctly */
    overflow: hidden;
    width: 100%;
    background: #111;
    width: 100%;
    padding: 10px;
    border-radius: 4px;
    border: 1px dashed #444;
    box-sizing: border-box;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .backdrop.focused {
    background: #171717;
    border: 1px solid #444;
  }
  textarea {
    position: absolute;
    background: transparent;
    color: transparent;
    width: 100%;
    margin: 0;
    padding: 10px;
    outline: none;
    border-radius: 0;
    border: 1px solid transparent;
    overflow: hidden;
    box-sizing: border-box;
    display: block; /* removed additional space below, see https://stackoverflow.com/a/7144960 */
    resize: none;
  }
  :global(mark) {
    /* color: transparent; */
    background: #999;
    border-radius: 4px;
    padding: 0 2px;
    margin: 0 -2px;
    cursor: pointer;
  }
  :global(mark.language) {
    background: #7bf;
  }
  :global(.block) {
    background: rgba(0, 0, 0, 0.5);
    border-radius: 4px;
    padding: 1px;
    margin: -1px;
  }
  :global(.block-delimiter) {
    color: #666;
  }
  :global(.editor .code, .editor .math) {
    background: rgba(0, 0, 0, 0.5);
    padding: 2px 4px;
    margin: -2px -4px;
    border-radius: 4px;
  }
  :global(.section) {
    border: 1px dashed #444;
    margin: -1px -5px;
    padding: 0 4px;
  }
  :global(.section-delimiter) {
    color: #666;
  }
  :global(span.highlight.matched) {
    color: black;
    background: #9f9;
    border-radius: 4px;
  }
  :global(span.highlight.unmatched) {
    color: black;
    background: #f99;
    border-radius: 4px;
  }

  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    .backdrop,
    textarea {
      font-size: 13px;
      line-height: 21px;
    }
  }
</style>

<div bind:this={editor} class="editor">
  <div class="backdrop" class:focused bind:this={backdrop}>
    <div id="highlights" bind:this={highlights}>{placeholder}</div>
  </div>
  <textarea
    spellcheck={false}
    id={'textarea-' + id}
    bind:this={textarea}
    {placeholder}
    on:input={onInput}
    on:click={onInput}
    on:keydown={onKeyDown}
    on:keyup={onKeyUp}
    on:keypress={onKeyPress}
    on:focus={() => onFocused((focused = true))}
    on:blur={() => onFocused((focused = false))}
    autocapitalize="off">{text}</textarea>
</div>

<!-- update editor on window resize (height changes due to text reflow) -->
<svelte:window on:resize={updateTextDivs} />
