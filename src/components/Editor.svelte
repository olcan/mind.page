<style>
    #editor {
        position: relative;
        height: 49px; /*  */
        min-height: 1.2em;
        width: 100%;
        cursor: text;
    }
    #backdrop {
        color: transparent; 
        position: absolute;
        overflow: auto;
        width: 100%;
        background: #1b1b1b;
        min-height: 49px;
        width: 100%;
        margin: 0;
        padding: 10px;
        box-sizing: border-box;
        white-space: pre-wrap;
        word-wrap: break-word;
        /* font-family: "menlo", monospace;
        font-size: 1.2em; */
        font-family: Helvetica;
        font-size: 1.3em;
        line-height: 1.4em;
    }
    textarea {
        position: absolute;
        background: transparent;
        color: #ddd;
        /* font-family: "menlo", monospace;
        font-size: 1.2em; */
        font-family: Helvetica;
        font-size: 1.3em;
        line-height: 1.4em;
        min-height: 49px;
        width: 100%;
        margin: 0;
        padding: 10px;
        box-sizing: border-box; /* include padding/border in sizing for 100% width*/
        outline: none;
        border: 0;
        border-radius: 0;
        display: block; /* removed additional space below, see https://stackoverflow.com/a/7144960 */
        resize: none;
    }    
    :global(mark) {
        color: transparent;
        background-color: #333; /* or whatever */
        border-radius: 4px;
        margin: -1px;
        padding: 1px;
    }
</style>

<script lang="ts">
    export let id = "editor"
    export let text = ""
    export let onFocused = (focused:boolean)=>{}
    export let onChange = (text)=>{}
    export let onDone = (text)=>{}

    const placeholder = " "
    let editor: HTMLDivElement
    let backdrop: HTMLDivElement
    let highlights: HTMLDivElement
    let textarea: HTMLTextAreaElement
    let applyHighlights = (t) => t.replace(/\n$/g,'\n\n').replace(/(#\w+?\b|#)/g, '<mark>$1</mark>');
    
    function updateTextDivs() {
        highlights.innerText = textarea.value || placeholder; /*innerText escapes html*/
        highlights.innerHTML = applyHighlights(highlights.innerText);
        textarea.style.height = editor.style.height = backdrop.scrollHeight + 'px'
    }
    function onKeyPress(e: KeyboardEvent) {
        if (e.code == "Enter" && e.shiftKey) {
            e.preventDefault()
            onDone(textarea.value.trim())
        }
    }

    function onInput() {
        text = textarea.value.trim()
        updateTextDivs()
        onChange(textarea.value.trim())
    }

    import { afterUpdate } from 'svelte';
    afterUpdate(updateTextDivs);
    
</script>

<div bind:this={editor} id="editor">
    <div bind:this={backdrop} id="backdrop"><div bind:this={highlights}>{placeholder}</div></div>
    <!-- use autocapitalize=off to disable capitalization -->
    <textarea id={"textarea-"+id} bind:this={textarea} placeholder={placeholder} on:input={onInput} on:keypress={onKeyPress} on:focus={()=>onFocused(true)} on:blur={()=>onFocused(false)}>{text}</textarea>
</div>

<!-- update editor on window resize (height changes due to text reflow) -->
<svelte:window on:resize={updateTextDivs}/>