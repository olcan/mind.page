<script lang="ts">
  export let id = "editor";
  export let text = "";
  export let focused = false;
  export let onFocused = (focused: boolean) => {};
  export let onChange = (text) => {};
  export let onDone = (text: string, e: KeyboardEvent) => {};
  export let onPrev = () => {};
  export let onNext = () => {};

  import "highlight.js/styles/sunburst.css";
  import hljs from "highlight.js/lib/core"; // NOTE: needs npm i @types/highlight.js -s
  import plaintext from "highlight.js/lib/languages/plaintext.js";
  hljs.registerLanguage("plaintext", plaintext);
  import javascript from "highlight.js/lib/languages/javascript.js";
  hljs.registerLanguage("javascript", javascript);
  import typescript from "highlight.js/lib/languages/typescript.js";
  hljs.registerLanguage("typescript", typescript);
  import css from "highlight.js/lib/languages/css.js";
  hljs.registerLanguage("css", css);
  import json from "highlight.js/lib/languages/json.js";
  hljs.registerLanguage("json", json);
  import xml from "highlight.js/lib/languages/xml.js";
  hljs.registerLanguage("xml", xml); // including html
  hljs.configure({
    tabReplace: "    ",
  });

  const placeholder = " ";
  let editor: HTMLDivElement;
  let backdrop: HTMLDivElement;
  let highlights: HTMLDivElement;
  let textarea: HTMLTextAreaElement;
  let escapeHTML = (t) =>
    t
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  let highlightTags = (t) => t.replace(/(^|\s)(#[^#\s]+)/g, "$1<mark>$2</mark>");
  let highlightCode = (t) => t.replace(/(`.*?`)/g, '<span class="code">$1</span>');
  let highlightMath = (t) => t.replace(/(\$\$?.+?\$\$?)/g, '<span class="math">$1</span>');

  function updateTextDivs() {
    const text = textarea.value || placeholder;
    let insideBlock = false;
    let language = "";
    let code = "";
    let html = "";
    text.split("\n").map((line) => {
      if (!insideBlock && line.match(/^\s*```(\w+)$/)) {
        insideBlock = true;
        language = line.match(/^\s*```(\w+)$/).pop();
        if (language == "js_input") language = "js";
        if (language == "webppl") language = "js";
        if (language == "_html") language = "html";
        language = hljs.getLanguage(language) ? language : "plaintext";
        code = "";
        html += '<span class="block-delimiter">';
        html += escapeHTML(line);
        html += "</span>\n";
      } else if (insideBlock && line.match(/^\s*```/)) {
        html += '<div class="block">';
        html += hljs.highlight(language, code).value;
        html += "</div>";
        insideBlock = false;
        html += '<span class="block-delimiter">';
        html += escapeHTML(line);
        html += "</span>\n";
      } else if (insideBlock) {
        code += line + "\n";
      } else {
        if (line.match(/^    \s*[^\-\*]/)) html += line + "\n";
        else html += highlightMath(highlightCode(highlightTags(escapeHTML(line)))) + "\n";
      }
    });
    // append unclosed block as regular markdown
    if (insideBlock) html += highlightMath(highlightCode(highlightTags(escapeHTML(code))));

    // wrap hidden sections
    html = html.replace(
      /(^|\n\s*?)(&lt;!--\s*?hidden\s*?--&gt;.+?&lt;!--\s*?\/hidden\s*?--&gt;\s*?\n)/gs,
      '$1<div class="hidden">$2</div>'
    );

    highlights.innerHTML = html;
    textarea.style.height = editor.style.height = backdrop.scrollHeight + "px";
  }

  function onKeyDown(e: KeyboardEvent) {
    // console.log(e);
    // https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code/code_values

    // indent/comment selection or current line
    if (
      ((e.code == "BracketLeft" || e.code == "BracketRight") && (e.metaKey || e.ctrlKey)) ||
      (e.code == "Tab" && textarea.selectionEnd > textarea.selectionStart) ||
      (e.code == "Slash" && (e.metaKey || e.ctrlKey))
    ) {
      e.preventDefault();
      e.stopPropagation(); // do not propagate to window
      const oldStart = textarea.selectionStart;
      let oldEnd = textarea.selectionEnd;
      let oldLength = textarea.value.length;
      // move selection to line start
      let lineStart = textarea.value.substring(0, textarea.selectionStart).replace(/[^\n]*$/, "").length;
      if (textarea.selectionStart == textarea.selectionEnd && e.code == "BracketRight") {
        textarea.selectionStart = textarea.selectionEnd = lineStart;
      } else {
        textarea.selectionStart = lineStart;
      }
      // expand selection to end of last line
      // if selection ends right after a new line, exclude the last line
      if (textarea.selectionEnd > textarea.selectionStart && textarea.value[textarea.selectionEnd - 1] == "\n")
        textarea.selectionEnd--;
      let lastLineStart = textarea.value.substring(0, textarea.selectionEnd).replace(/[^\n]*$/, "").length;
      let lineEnd =
        lastLineStart +
        textarea.value
          .substring(lastLineStart)
          .match(/^[^\n]*/)[0]
          .trimEnd().length;
      textarea.selectionEnd = lineEnd;

      // NOTE: execCommand maintains undo/redo history
      let selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
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
    // NOTE: there can be slight delay on caret update, but seems to be a Mac-only problem
    if (e.code == "Enter" && !(e.shiftKey || e.metaKey || e.ctrlKey)) {
      let spaces = textarea.value.substring(0, textarea.selectionStart).match(/(?:^|\n)( *).*?$/);
      document.execCommand("insertText", false, "\n" + spaces[1] || "");
      e.preventDefault();
    }

    // navigate to prev/next item by handling arrow keys (without modifiers) that go out of bounds
    if (!(e.shiftKey || e.metaKey || e.ctrlKey)) {
      if ((e.code == "ArrowUp" || e.code == "ArrowLeft") && textarea.selectionStart == 0) {
        e.stopPropagation();
        e.preventDefault();
        onPrev();
        return;
      }
      if ((e.code == "ArrowDown" || e.code == "ArrowRight") && textarea.selectionStart == textarea.value.length) {
        e.stopPropagation();
        e.preventDefault();
        onNext();
        return;
      }
    }

    // remove spaced tabs with backspace
    // (for backspace, unlike shift-tab, we require/allow an _extra_ space)
    if (
      e.code == "Backspace" &&
      !(e.shiftKey || e.metaKey || e.ctrlKey) &&
      textarea.selectionStart >= 3 &&
      textarea.value.substring(textarea.selectionStart - 3, textarea.selectionStart).match(/\s  /)
    ) {
      textarea.selectionStart = textarea.selectionStart - 2;
      document.execCommand("delete", false);
      e.preventDefault();
    }

    // delete empty item with backspace
    if (e.code == "Backspace" && textarea.value.trim() == "" && textarea.selectionStart == 0) {
      onDone((text = ""), e);
      e.preventDefault();
      return;
    }

    // "close" non-empty item with backspace (w/o modifier keys) at the start
    if (e.code == "Backspace" && !(e.shiftKey || e.metaKey || e.ctrlKey) && textarea.selectionStart == 0) {
      onDone(text /* maintain text */, e /* report backspace, which can be used to maintain time */);
      e.preventDefault();
      return;
    }

    // delete non-empty item with Shift/Cmd/Ctrl+Backspace
    // NOTE: Cmd-Backspace may be assigned already to "delete line" and overload requires disabling on key down
    if (e.code == "Backspace" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      // For shift-backspace, to reduce accidental deletion, we require that the caret be placed at the start
      if (e.metaKey || e.ctrlKey || textarea.selectionStart == 0) {
        onDone((text = ""), e);
        e.preventDefault();
        return;
      }
    }

    // insert spaces on Tab
    if (e.code == "Tab") {
      e.preventDefault();
      if (!e.shiftKey) {
        // forward tab
        document.execCommand("insertText", false, "  ");
      } else if (
        textarea.selectionStart >= 2 &&
        textarea.value.substring(textarea.selectionStart - 2, textarea.selectionStart) == "  "
      ) {
        textarea.selectionStart = textarea.selectionStart - 2;
        document.execCommand("delete", false);
      }
      onInput();
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    // // maintain indentation of previous line on enter (without modifiers)
    // if (e.code == "Enter" && !(e.shiftKey || e.metaKey || e.ctrlKey)) {
    //   let spaces = textarea.value
    //     .substring(0, textarea.selectionStart)
    //     .match(/(?:^|\n)( *).*?\n$/);
    //   if (spaces && spaces[1].length > 0)
    //     document.execCommand("insertText", false, spaces[1]);
    // }
  }

  function onKeyPress(e: KeyboardEvent) {
    // add/save item with Cmd/Ctrl/Shift+Enter or Cmd/Ctrl+S
    if (
      (e.code == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) ||
      (e.code == "KeyS" && (e.metaKey || e.ctrlKey))
    ) {
      e.preventDefault();
      e.stopPropagation(); // do not propagate to window
      onDone((text = textarea.value.trim()), e);
      return;
    }
  }

  function onInput() {
    // force replace tabs with spaces
    if (textarea.value.indexOf("\t") >= 0) {
      // if textarea starts with a bullet, convert all tabs to indented bullets (e.g. for MindNode import)
      if (textarea.value.match(/^[-*]\s/)) textarea.value = textarea.value.replace(/(\t+)/g, "$1- ");
      textarea.value = textarea.value.replace(/\t/g, "  ");
    }
    text = textarea.value; // no trimming until onDone
    updateTextDivs();
    onChange(textarea.value);
  }

  import { afterUpdate } from "svelte";
  afterUpdate(updateTextDivs);
</script>

<style>
  #editor {
    position: relative;
    width: 100%;
    cursor: text;
  }
  .backdrop,
  textarea {
    font-family: monospace;
    font-size: 15px;
    line-height: 25px;
  }
  .backdrop {
    /* color: transparent; */
    color: #ddd;
    position: absolute;
    overflow: auto;
    width: 100%;
    background: #1b1b1b;
    border-radius: 0 4px 4px 0;
    width: 100%;
    margin: 0;
    padding: 10px;
    box-sizing: border-box; /* essential for proper sizing of textarea */
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .backdrop.focused {
    background: #222;
  }
  textarea {
    position: absolute;
    background: transparent;
    caret-color: red;
    color: transparent;
    width: 100%;
    margin: 0;
    padding: 10px;
    box-sizing: border-box; /* essential for proper sizing of textarea */
    outline: none;
    border: 0;
    border-radius: 0;
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
    background: #171717;
    border-radius: 4px;
    padding: 1px;
    margin: -1px;
  }
  :global(.block-delimiter) {
    color: #666;
  }
  :global(#editor .code, #editor .math) {
    background: #171717;
    padding: 2px 4px;
    margin: -2px -4px;
    border-radius: 4px;
  }
  :global(.hidden) {
    opacity: 0.5;
    border-top: 1px dashed gray;
    border-bottom: 1px dashed gray;
    margin: -1px 0;
  }

  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    .backdrop,
    textarea {
      font-size: 13px;
      line-height: 22px;
    }
  }
</style>

<div bind:this={editor} id="editor">
  <div class="backdrop" class:focused bind:this={backdrop}>
    <div id="highlights" bind:this={highlights}>{placeholder}</div>
  </div>
  <textarea
    spellcheck={false}
    id={'textarea-' + id}
    bind:this={textarea}
    {placeholder}
    on:input={onInput}
    on:keydown={onKeyDown}
    on:keyup={onKeyUp}
    on:keypress={onKeyPress}
    on:focus={() => onFocused((focused = true))}
    on:blur={() => onFocused((focused = false))}
    autocapitalize="off">{text}</textarea>
</div>

<!-- update editor on window resize (height changes due to text reflow) -->
<svelte:window on:resize={updateTextDivs} />
