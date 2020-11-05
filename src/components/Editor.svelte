<style>
    #editor {
        position: relative;
        height: 49px; /* exact size with one-line placeholder, to avoid content shift below */
        min-height: 1.2em;
        width: 100%;
    }
    #backdrop {
        color: transparent; 
        position: absolute;
        overflow: auto;
        width: 100%;
        background: #222;
        min-height: 1.2em;
        width: 100%;
        margin: 0;
        padding: 10px;
        box-sizing: border-box;
        white-space: pre-wrap;
        word-wrap: break-word;
        font-family: Helvetica;
        font-size: 1.3em;
        line-height: 1.4em;
    }
    textarea {
        position: absolute;
        background: transparent;
        color: #ddd;
        font-family: Helvetica;
        font-size: 1.3em;
        line-height: 1.4em;
        min-height: 1.2em;
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
    const placeholder = "What's happening?";
    let textarea: HTMLTextAreaElement;
    let editor: HTMLDivElement;
    let backdrop: HTMLDivElement;
    let highlights: HTMLDivElement;
    let applyHighlights = (t) => t.replace(/\n$/g,'\n\n').replace(/(#\w+?\b|#)/g, '<mark>$1</mark>');
    
    function updateTextDivs() {
        highlights.innerText = textarea.value || placeholder; /*innerText escapes html*/
        highlights.innerHTML = applyHighlights(highlights.innerText);
        textarea.style.height = editor.style.height = backdrop.scrollHeight + 'px';        
    }
    function disableSaveShortcut(e: KeyboardEvent) { // disable Ctrl/Cmd+S
        if (e.code == "KeyS" && (window.navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)) {
            e.preventDefault();
        }
    }
    function handleKeyPress(e: KeyboardEvent) {
        if (e.code == "Enter" && e.shiftKey) {
            e.preventDefault();
            alert(textarea.value)
        }
    }

    import { onMount } from 'svelte';
    onMount(updateTextDivs); // perform initial sizing for divs below editor
    
</script>

<div bind:this={editor} id="editor">
    <div bind:this={backdrop} id="backdrop"><div bind:this={highlights}>{placeholder}</div></div>
    <textarea bind:this={textarea} placeholder={placeholder} on:input={updateTextDivs} on:keypress={handleKeyPress} autocapitalize=off/>
    <slot></slot>
</div>

<!-- disable cmd/ctrl-S and update editor on window resize -->
<svelte:window on:keydown={disableSaveShortcut} on:resize={updateTextDivs}/>