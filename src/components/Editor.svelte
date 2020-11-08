<style>
    #editor {
        position: relative;
        height: 49px; /*  */
        min-height: 1.2em;
        width: 100%;
        cursor: text;
    }
    .backdrop {
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
    .backdrop.focused {
        background: #222;        
    }
    #partial {
        visibility: false
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
        background: rgba(30,90,255,.35);
        border-radius: 4px;
        padding: 1px 1px;
        border: 1px solid rgba(30,90,255,.7);
        margin: -2px -2px;
        cursor: pointer;
    }
</style>

<script lang="ts">
    export let id = "editor"
    export let text = ""
    export let focused = false
    export let onFocused = (focused:boolean)=>{}
    export let onChange = (text)=>{}
    export let onDone = (text)=>{}
    export let autofocus = false

    const placeholder = " "
    let editor: HTMLDivElement
    let backdrop: HTMLDivElement
    let partial: HTMLDivElement
    let highlights: HTMLDivElement    
    let textarea: HTMLTextAreaElement
    let applyHighlights = (t) => t.replace(/\n$/g,'\n\n').replace(/(#[#\w]*)/g, '<mark>$1</mark>');
    
    function updateTextDivs() {
        highlights.innerText = textarea.value || placeholder; /*innerText escapes html*/
        highlights.innerHTML = applyHighlights(highlights.innerText);
        textarea.style.height = editor.style.height = backdrop.scrollHeight + 'px'
    }
    function onKeyDown(e: KeyboardEvent) {
		// For codes, see https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code/code_values
        if ((e.code == "ArrowDown" || e.code == "ArrowUp") && textarea.selectionStart == textarea.selectionEnd) {
            partial.innerText = " "
            const lineHeight = partial.clientHeight            
            partial.innerText = (textarea.value + " "/*include line break*/).substring(0,textarea.selectionStart+1)
            textarea.setAttribute("updownline", Math.max(1, partial.clientHeight / lineHeight).toString())
            textarea.setAttribute("lines", Math.max(1, highlights.clientHeight / lineHeight).toString())
        }
        // trigger deletion with backspace
        if (e.code == "Backspace" && textarea.value.trim()=="" && textarea.selectionStart == textarea.selectionEnd && textarea.selectionStart == 0) {
            onDone(textarea.value.trim())
            e.stopPropagation()
            e.preventDefault()
        }
    }
    function onKeyPress(e: KeyboardEvent) {
        if ((e.code == "Enter" && e.shiftKey) || 
            (e.code == "KeyS" && (window.navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey))) {
            e.preventDefault()
            onDone(textarea.value.trim())
        }
    }

    function onInput() {
        text = textarea.value.trim()
        updateTextDivs()
        onChange(textarea.value.trim())
    }

    import { onMount, afterUpdate } from 'svelte';
    onMount(()=>{if(autofocus) textarea.focus()})
    afterUpdate(updateTextDivs);
    
</script>

<div bind:this={editor} id="editor">
    <div class="backdrop"><div id="partial" bind:this={partial}></div></div>
    <div class="backdrop" class:focused bind:this={backdrop}><div id="highlights" bind:this={highlights}>{placeholder}</div></div>
    <!-- use autocapitalize=off to disable capitalization -->
    <textarea id={"textarea-"+id} bind:this={textarea} placeholder={placeholder} on:input={onInput} on:keydown={onKeyDown} on:keypress={onKeyPress} on:focus={()=>onFocused(focused=true)} on:blur={()=>onFocused(focused=false)}>{text}</textarea>
</div>

<!-- update editor on window resize (height changes due to text reflow) -->
<svelte:window on:resize={updateTextDivs}/>