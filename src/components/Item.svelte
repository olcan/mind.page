<script lang="ts">
    // Markdown library requires import as ESM (ECMAScript module)
    // See https://github.com/markedjs/marked/issues/1692#issuecomment-636596320
    import marked from "marked";

    import "highlight.js/styles/monokai-sublime.css";
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

    let renderer = new marked.Renderer();
    renderer.link = (href, title, text) => {
        return `<a target="_blank" href="${href}" title="${
            title || text
        }" onclick="event.stopPropagation()">${text}</a>`;
    };
    // marked.use({ renderer });
    marked.setOptions({
        renderer: renderer,
        highlight: function (code, language) {
            // https://github.com/highlightjs/highlight.js/blob/master/SUPPORTED_LANGUAGES.md
            //if (language=="") return hljs.highlightAuto(code).value;
            const validLanguage = hljs.getLanguage(language)
                ? language
                : "plaintext";
            return hljs.highlight(validLanguage, code).value;
        },
    });

    let itemdiv: HTMLDivElement;
    import { afterUpdate } from "svelte";
    afterUpdate(() => {
        if (!itemdiv) return;
        // remove <code></code> wrapper block
        Array.from(document.getElementsByTagName("code")).forEach((code) => {
            if (
                code.textContent.startsWith("$") &&
                code.textContent.endsWith("$")
            )
                code.outerHTML = code.innerHTML;
        });
        Array.from(document.getElementsByTagName("pre")).forEach((pre) => {
            if (
                pre.textContent.startsWith("$") &&
                pre.textContent.endsWith("$")
            )
                pre.outerHTML =
                    "<blockquote>" + pre.innerHTML + "</blockquote>";
        });
        const prevheight = height;
        const heightid = id; // capture for async callback
        const typesetdiv = itemdiv; // capture for async callback
        // NOTE: we have to capture any item state used in callback since the component state can be modified/reused during callback
        window["MathJax"]
            .typesetPromise([itemdiv])
            .then(() => {
                typesetdiv
                    .querySelectorAll(".MathJax")
                    .forEach((elem) => elem.setAttribute("tabindex", "-1"));
                onHeightAsync(heightid, typesetdiv.clientHeight, prevheight);
            })
            .catch(console.error);
    });

    export let onTagClick = (tag: string) => {};
    window["handleTagClick"] = (tag: string) => {
        onTagClick(tag);
    };

    const textReplace = (str, subStr, newSubStr) => {
        let mdBlock = false;
        return str
            .split("\n")
            .map((str) => {
                if (str.match(/^```/)) {
                    mdBlock = !mdBlock;
                }
                return mdBlock || str.match(/^```|^    /)
                    ? str
                    : str + "<br>\n";
            })
            .join("\n");
    };

    function toHTML(text: string) {
        // NOTE: modifications should only happen outside of code blocks
        let insideBlock = false;
        text = text
            .split("\n")
            .map((line) => {
                let str = line;
                if (str.match(/^```/)) {
                    insideBlock = !insideBlock;
                }
                // preserve line breaks by inserting <br> outside of code blocks
                if (!insideBlock && !str.match(/^```|^    /)) str += "<br>";
                if (!insideBlock) {
                    // hide #pin and #pin/* (not useful visually or for clicking)
                    str = str.replace(/(?:^|\s)#pin(?:\s|$)/, "");
                    str = str.replace(/(?:^|\s)#pin\/[\/\w]*(?:\s|$)/, "");
                    // style vertical separator bar │
                    str = str.replace(
                        /│/g,
                        '<span class="vertical-bar">│</span>'
                    );
                    // wrap #tags inside clickable <mark></mark>
                    str = str.replace(
                        /(^|\s)(#[\/\w]+)/g,
                        `$1<mark onclick="handleTagClick('$2');event.stopPropagation()">$2</mark>`
                    );
                }
                return str;
            })
            .join("\n")
            .replace(/\\<br>\n/g, "");
        return marked(text);
    }

    import Editor from "./Editor.svelte";
    export let editing = false;
    export let focused = false;
    export let saving = false;
    // NOTE: required props should not have default values
    export let index: number;
    export let id: string;
    export let itemCount: number;
    export let time: number;
    export let timeString: string;
    export let timeOutOfOrder: boolean;
    export let updateTime: number;
    export let createTime: number;
    let debugString = `${time}, ${updateTime}, ${createTime}`;
    export let text: string;
    export let height = 0;
    const placeholder = " ";
    let error = false;
    export let onEditing = (index: number, editing: boolean) => {};
    export let onFocused = (index: number, focused: boolean) => {};
    export let onHeightAsync = (
        id: string,
        height: number,
        prevheight: number
    ) => {};
    export let onPrev = () => {};
    export let onNext = () => {};

    import { firestore } from "../../firebase.js";
    function onDone() {
        onEditing(index, (editing = false));
    }
    function onClick() {
        if (window.getSelection().type == "Range") return; // ignore click if text is selected
        onEditing(index, (editing = true));
    }
</script>

<style>
    .super-container {
        /* break-inside: avoid; */
        margin: 4px 0;
        margin-right: 8px;
    }
    .container {
        /* border: 1px solid transparent; */
        border-left: 2px solid #444;
        /* overflow: hidden; */
        /* max-width: 600px; */
    }
    .container.focused {
        /* border: 1px solid #666; */
        border-left: 2px solid #aaa;
    }
    .index {
        float: right;
        color: #333;
        /* padding-right: 4px; */
        font-family: Helvetica;
        text-align: right;
    }
    .time {
        color: #444;
        display: inline-block;
        padding-left: 5px;
        padding-right: 5px;
        margin-bottom: 4px; /* should match vertical margin of .super-container */
        /* margin-bottom: 4px; */
        font-family: Helvetica;
        font-size: 15px;
    }
    .time.timeOutOfOrder {
        background: #666;
        padding-left: 15px;
        padding-bottom: 1px;
        color: black;
        border-radius: 0 4px 4px 0;
        /* display: block; */
    }
    .debug {
        /* display: inline-block; */
        display: none;
        color: #444;
        font-family: Helvetica;
    }
    .item {
        color: #ddd;
        width: 100%;
        min-height: 48px;
        background: transparent;
        padding: 10px;
        box-sizing: border-box;
        /* white-space: pre-wrap; */
        word-wrap: break-word;
        font-family: Helvetica;
        font-size: 1.25em;
        line-height: 1.4em;
        /* cursor: pointer; */
    }
    .saving {
        opacity: 0.5;
    }
    .error {
        color: red;
    }

    /* :global prevents unused css errors and allows matches to elements from other components (see https://svelte.dev/docs#style) */
    .item :global(h1, h2, h3, h4, h5, h6, p, ul, blockquote, pre) {
        margin: 0;
    }
    .item :global(li) {
        text-indent: -3px;
    }
    .item :global(ul) {
        padding-left: 21px;
        /* border-left: 1px solid #333; */
    }
    .item :global(blockquote) {
        padding-left: 15px;
        margin-bottom: 10px;
        border-left: 1px solid #333;
    }
    .item :global(pre) {
        padding-left: 15px;
        margin-bottom: 10px;
        border-left: 1px solid #333;
    }
    .item :global(br:last-child) {
        display: none;
    }
    .item :global(a) {
        color: #79e;
        text-decoration: none;
    }
    .item :global(mark) {
        color: black;
        background: #999;
        /* remove negative margins used to align with textarea text */
        margin: 0;
    }
    .item :global(.vertical-bar) {
        color: #444;
    }
    .item :global(:first-child) {
        margin-top: 0;
    }
    .item :global(:last-child) {
        margin-bottom: 0;
    }
    :global(.MathJax) {
        margin-bottom: 0 !important;
    }
    :global(blockquote .MathJax) {
        display: block;
        padding-top: 5px;
        padding-bottom: 5px;
    }
    /* adapt to smaller windows/devices */
    @media only screen and (max-width: 600px) {
        .item {
            font-size: 1.15em;
            line-height: 1.4em;
        }
    }
</style>

<div class="super-container" bind:this={itemdiv}>
    {#if timeString}
        <div class="time" class:timeOutOfOrder>{timeString}</div>
    {/if}
    <div class="debug">{debugString}</div>
    <div class="container" class:editing class:focused class:timeOutOfOrder>
        <div class="index">
            {@html index > 0 ? index + 1 : itemCount + '<br>' + (index + 1)}
        </div>
        {#if editing}
            <Editor
                {id}
                bind:text
                bind:focused
                {onPrev}
                {onNext}
                onFocused={(focused) => onFocused(index, focused)}
                {onDone} />
        {:else}
            <div class="item" class:saving class:error on:click={onClick}>
                {@html toHTML(text || placeholder)}
            </div>
        {/if}
    </div>
</div>
