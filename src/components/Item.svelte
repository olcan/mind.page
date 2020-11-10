<style>
    .super-container {
        /* break-inside: avoid; */
        padding: 2px 0;
    }
    .container {
        margin-top: 4px; /* spacing from time */
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
        padding-right: 4px;
        font-family: Helvetica;
    }
    .time {
        color: #444;
        display: inline-block;
        padding-left: 5px;
        padding-right: 5px;
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
    .item {
        color: #ddd;
        width: 100%;
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
    .saving { opacity: 0.5; }
    .error { color:red; }
    .deleted { display: none; }
    
    /* :global prevents unused css errors and allows matches to elements from other components (see https://svelte.dev/docs#style) */
    .item :global(h1,h2,h3,h4,h5,h6,p,ul,blockquote,pre) { margin: 0 }
    .item :global(li) { text-indent: -3px; }
    .item :global(ul) {
        padding-left: 30px;
        border-left: 1px solid #333;
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
    .item :global(br:last-child) { display: none; }
    .item :global(a) { color: #69f; text-decoration: none;}
    .item :global(mark) { 
        color: black; 
        background: #999;
        padding: 1px 2px;
        margin: -1px -2px;
        border: 0;
    }
    .item :global(:first-child) { margin-top: 0; }
    .item :global(:last-child) { margin-bottom: 0; }
    :global(.MathJax) { margin-bottom: 0 !important; }
    :global(blockquote .MathJax) { 
        display: block; 
        padding-top: 5px;
        padding-bottom: 5px;
    }
    
</style>

<script lang="ts">
    // Markdown library requires import as ESM (ECMAScript module)
    // See https://github.com/markedjs/marked/issues/1692#issuecomment-636596320
    import marked from 'marked'
    
    import 'highlight.js/styles/monokai-sublime.css';
    import hljs from 'highlight.js/lib/core' // NOTE: needs npm i @types/highlight.js -s
    import plaintext from 'highlight.js/lib/languages/plaintext.js';
    hljs.registerLanguage('plaintext', plaintext);
    import javascript from 'highlight.js/lib/languages/javascript.js';
    hljs.registerLanguage('javascript', javascript);
    import typescript from 'highlight.js/lib/languages/typescript.js';
    hljs.registerLanguage('typescript', typescript);
    import css from 'highlight.js/lib/languages/css.js';
    hljs.registerLanguage('css', css);
    import json from 'highlight.js/lib/languages/json.js';
    hljs.registerLanguage('json', json);
    import xml from 'highlight.js/lib/languages/xml.js';
    hljs.registerLanguage('xml', xml); // including html
    
    let renderer = new marked.Renderer()
    renderer.link = (href, title, text) => {
        return `<a target="_blank" href=${href} title=${title} onclick="event.stopPropagation()">${text}</a>`;
    }
    // marked.use({ renderer });
    marked.setOptions({
        renderer: renderer,
        highlight: function(code, language) {
            // https://github.com/highlightjs/highlight.js/blob/master/SUPPORTED_LANGUAGES.md
            //if (language=="") return hljs.highlightAuto(code).value;
            const validLanguage = hljs.getLanguage(language) ? language : 'plaintext';
            return hljs.highlight(validLanguage, code).value;
        }
    })
    
    let itemdiv: HTMLDivElement
    import { afterUpdate } from 'svelte';
    afterUpdate(()=>{
        if (!itemdiv) return
        // remove <code></code> wrapper block
        Array.from(document.getElementsByTagName('code')).forEach((code)=>{
            if (code.textContent.startsWith('$') && code.textContent.endsWith('$'))
            code.outerHTML = code.innerHTML;
        })
        Array.from(document.getElementsByTagName('pre')).forEach((pre)=>{
            if (pre.textContent.startsWith('$') && pre.textContent.endsWith('$'))
            pre.outerHTML = "<blockquote>" + pre.innerHTML + "</blockquote>";
        })
        window["MathJax"].typesetPromise([itemdiv]).then(()=>{
            itemdiv.querySelectorAll(".MathJax").forEach((elem)=>elem.setAttribute("tabindex", "-1"))
            height = itemdiv.clientHeight
        }).catch(console.error)
    });
    
    export let onTagClick = (tag:string)=>{}
    window["handleTagClick"] = (tag:string) => { onTagClick(tag) }
    
    const textReplace = (str, subStr, newSubStr) => {
        let mdBlock = false;
        return str.split('\n').map(str => {
            if (str.match(/^```/)) { mdBlock = !mdBlock; }
            return mdBlock || str.match(/^```|^    /) ? str : str + "<br>\n"
        }).join('\n');
    };
    
    function toHTML(text: string) {
        // wrap #tags inside clickable <mark></mark>
        text = text.replace(/(#\w+)/g, `<mark onclick="handleTagClick('$1');event.stopPropagation()">$1</mark>`);
        // preserve line breaks by inserting <br> outside of code blocks
        let insideBlock = false;
        text = text.split('\n').map(str => {
            if (str.match(/^```/)) { insideBlock = !insideBlock; }
            return insideBlock || str.match(/^```|^    /) ? str : str + "<br>\n"
        }).join('\n');
        return marked(text);
    }
    
    import Editor from './Editor.svelte'
    export let editing = false
    export let focused = false
    export let saving = false
    export let deleted = false
    // NOTE: required props should not have default values
    export let index: number
    export let id: string
    export let time: number
    export let timeString: string
    export let timeOutOfOrder: boolean
    export let text: string
    export let savedText: string
    export let height = 0;
    const placeholder = " "
    let error = false
    export let onEditing = (index:number, editing:boolean)=>{}
    export let onFocused = (index:number, focused:boolean)=>{}
    export let onDeleted = (index:number)=>{}
    export let onPrev = ()=>{}
    export let onNext = ()=>{}
    
    import { firestore } from '../../firebase.js'
    function onEditorDone() {
        // NOTE: text is already trimmed for onDone
        editing = false
        onEditing(index, false)
        if (text.length > 0 && text == savedText) return /* no change, no deletion */
        
        time = Date.now() // we track last modified time
        saving = true
        const item = {time:time, text:text};

        if (text.length == 0) { // delete
            deleted = true /* reflect immediately, since failure is not too serious */
            onDeleted(index)
            firestore().collection("items").doc(id).delete().then(()=>{saving=false;savedText=item.text})
            .catch((error)=>{console.error(error);error=true})
        } else { // update
            firestore().collection("items").doc(id).update(item).then(()=>{saving=false;savedText=item.text})
            .catch((error)=>{console.error(error);error=true})
            // also save to items-history ...
            firestore().collection("items-history").add({item:id, ...item}).catch(console.error)
        }
    }
    function onClick() {
        editing = true
        onEditing(index, true)
    }
    
</script>

<div class="super-container">
    {#if timeString} <div class="time" class:timeOutOfOrder>{timeString}</div> {/if}
    <div class="container" class:editing class:focused class:timeOutOfOrder>
        <div class="index">{index}</div>
        {#if editing}
        <Editor id={id} bind:text={text} bind:focused={focused} onPrev={onPrev} onNext={onNext} onFocused={(focused)=>onFocused(index,focused)} onDone={onEditorDone}></Editor>
        {:else}
        <div class="item" bind:this={itemdiv} class:saving class:error class:deleted on:click={onClick}>{@html toHTML(text||placeholder)}</div>
        {/if}
    </div>
</div>