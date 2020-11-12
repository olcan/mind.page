<style>
    #editor {
        position: relative;
        height: 48px;
        width: 100%;
        cursor: text;
        break-inside: avoid-column;
    }
    .backdrop, textarea {
        font-family: Helvetica;
        font-size: 1.25em;
        line-height: 1.4em;
    }
    .backdrop {
        color: transparent; 
        position: absolute;
        overflow: auto;
        width: 100%;
        background: #1b1b1b;
        border-radius: 0 4px 4px 0;
        min-height: 48px;
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
    /* #partial {
        visibility: false
    } */
    textarea {
        position: absolute;
        background: transparent;
        color: #ddd;
        min-height: 48px;
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
        color: transparent;
        /* background: rgba(30,90,255,.25); */
        background: #444;
        border-radius: 4px;
        padding: 0 2px;
        margin: 0 -2px;
        cursor: pointer;
    }
    /* adapt to smaller windows/devices */
    @media only screen and (max-width: 600px) {
        .backdrop, textarea { font-size: 1.15em; line-height: 1.4em; }
    }    
</style>

<script lang="ts">
    export let id = "editor"
    export let text = ""
    export let focused = false
    export let onFocused = (focused:boolean)=>{}
    export let onChange = (text)=>{}
    export let onDone = (text:string, e:KeyboardEvent)=>{}
    export let onPrev = ()=>{}
    export let onNext = ()=>{}
    export let autofocus = false
    
    const placeholder = " "
    let editor: HTMLDivElement
    let backdrop: HTMLDivElement
    // let partial: HTMLDivElement
    let highlights: HTMLDivElement    
    let textarea: HTMLTextAreaElement
    let escapeHTML = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;")
    let applyHighlights = (t) => t.replace(/\n$/g,'\n\n').replace(/(^|\s)(#[\/\w]+)/g, '$1<mark>$2</mark>');
    
    function updateTextDivs() {
        highlights.innerHTML = applyHighlights(escapeHTML(textarea.value || placeholder));
        textarea.style.height = editor.style.height = backdrop.scrollHeight + 'px'
    }
    
    let arrowUpDownLine = 0
    let arrowUpDownLines = 0
    let deleteOnBackspaceUp = false
    function onKeyDown(e: KeyboardEvent) {
        // console.log("onKeyDown",e)
        if (textarea.selectionStart != textarea.selectionEnd) return // we do not handle selection
        
        // navigate to prev/next item by handling arrow keys (without modifiers) that go out of bounds
        if (!(e.shiftKey || e.metaKey || e.ctrlKey)) {
            if ((e.code == "ArrowUp" || e.code == "ArrowLeft") && textarea.selectionStart == 0) {
                e.stopPropagation()
                e.preventDefault()
                onPrev()
                return
            }
            if ((e.code == "ArrowDown" || e.code == "ArrowRight") && textarea.selectionStart == textarea.value.length) {
                e.stopPropagation()
                e.preventDefault()
                onNext()
                return
            }
        }
        
        // delete item with backspace (safer if done on KeyUp)
        if (e.code == "Backspace" && textarea.value.trim()=="" && textarea.selectionStart == 0) {
            // deleteOnBackspaceUp = true
            onDone(text = textarea.value.trim(), e)
            e.preventDefault()
            return
        }

        // NOTE: Cmd-Backspace may be assigned already to "delete line" and overload requires disabling on key down
        if (e.code == "Backspace" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            text = textarea.value = ""
            setTimeout(()=>onDone(text, e), 0) // dispatching avoids some problems
            return
        }
    }
    
    function onKeyUp(e: KeyboardEvent) {
        if (textarea.selectionStart != textarea.selectionEnd) return // we do not handle selection
        if (deleteOnBackspaceUp && e.code == "Backspace" && textarea.value.trim()=="" && textarea.selectionStart == 0) {
            onDone(text = textarea.value.trim(), e)
            e.preventDefault()
            return
        }
    }
    
    function onKeyPress(e: KeyboardEvent) {
        // add/save item with Cmd/Ctrl/Shift+Enter or Cmd/Ctrl+S
        if ((e.code == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) || 
        (e.code == "KeyS" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault()
            onDone(text = textarea.value.trim(), e)
            return
        }
    }
    
    function onInput() {
        text = textarea.value // no trimming until onDone
        updateTextDivs()
        onChange(textarea.value)
    }
    
    import { onMount, afterUpdate } from 'svelte';
    onMount(()=>{if(autofocus) textarea.focus()})
    afterUpdate(updateTextDivs);
    
</script>

<div bind:this={editor} id="editor">
    <!-- <div class="backdrop"><div id="partial" bind:this={partial}></div></div> -->
    <div class="backdrop" class:focused bind:this={backdrop}><div id="highlights" bind:this={highlights}>{placeholder}</div></div>
    <textarea id={"textarea-"+id} bind:this={textarea} placeholder={placeholder} on:input={onInput} on:keydown={onKeyDown} on:keyup={onKeyUp} on:keypress={onKeyPress} on:focus={()=>onFocused(focused=true)} on:blur={()=>onFocused(focused=false)} autocapitalize=off>{text}</textarea>
</div>

<!-- update editor on window resize (height changes due to text reflow) -->
<svelte:window on:resize={updateTextDivs}/>