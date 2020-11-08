<style>
    .item-container {
        margin: 4px 0;
        border-left: 2px solid #444;
    }
    /* .item-container.editing {        
        border-left: 2px solid #aaa;
    } */
    .item-container.focused {
        /* border: 1px solid #777;        
        margin: -1px 0; */
        border-left: 2px solid #aaa;
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
        font-size: 1.3em;
        line-height: 1.4em;
        /* cursor: pointer; */
    }
    .saving {
        opacity: 0.5;
    }
    .error {
        color:red;
    }
    .deleted {
        display: none;
    }
    .item :global(p) {
        margin: 0;
        padding: 0;
    }
    .item :global(a) {
        color: #69f;
    }
    .item :global(mark) {
        color: #bbb;
    }
    .item :global(:first-child) { margin-top: 0; }
    .item :global(:last-child) { margin-bottom: 0; }
    :global(.MathJax) {
        margin-bottom: 0; /* unnecessary given break using <br> */
    }
    
</style>

<script lang="ts">
    // Markdown library requires import as ESM (ECMAScript module)
    // See https://github.com/markedjs/marked/issues/1692#issuecomment-636596320
    import marked from 'marked/lib/marked.esm.js'
    marked.setOptions({ breaks: true, smartLists: true })
    const renderer = {
        link: (href, title, text) => {
            return `<a target="_blank" href=${href} title=${title} onclick="event.stopPropagation()">${text}</a>`;
        }
    }
    marked.use({ renderer });
    
    let itemdiv: HTMLDivElement
    import { afterUpdate } from 'svelte';
    afterUpdate(()=>{
        if (!itemdiv) return
        window["MathJax"].typesetPromise([itemdiv]).then(()=>{
            itemdiv.querySelectorAll(".MathJax").forEach((elem)=>elem.setAttribute("tabindex", "-1"))
        }).catch(console.error)
    });
    
    export let onTagClick = (tag:string)=>{}
    window["handleTagClick"] = (tag:string) => { onTagClick(tag) }
    
    function toHTML(text: string) {
        text = text.replace(/(#[#\w]*)/g, `<mark onclick="handleTagClick('$1');event.stopPropagation()">$1</mark>`);
        return marked(text)
    }
    
    import Editor from './Editor.svelte'
    export let editing = false
    export let focused = false
    export let saving = false
    export let deleted = false
    export let index: number
    export let id: string
    export let time: number
    export let text = ""
    export let lastText = ""
    const placeholder = " "
    let error = false
    export let onEditing = (index:number, editing:boolean)=>{}
    export let onFocused = (index:number, focused:boolean)=>{}
    export let onDeleted = (index:number)=>{}
    
    import { firestore } from '../../firebase.js'
    function onEditorDone() {
        editing = false
        onEditing(index, false)
        if (text.length > 0 && text == lastText) return /* no change */
        // time = Date.now()
        saving = true
        const item = {time:time, text:text};
        
        if (text.trim().length == 0) { // delete
            deleted = true /* reflect immediately, since failure is not too serious */
            onDeleted(index)
            firestore().collection("items").doc(id).delete().then(()=>{saving=false})
            .catch((error)=>{console.error(error);error=true})
        } else { // update
            firestore().collection("items").doc(id).update(item).then(()=>{saving=false})
            .catch((error)=>{console.error(error);error=true})
        }
    }
    function onClick() { 
        lastText = text
        editing = true
        onEditing(index, true)
    }
    
</script>

<div class="item-container" class:editing class:focused>
    {#if editing}
    <Editor id={id} bind:text={text} bind:focused={focused} onFocused={(focused)=>onFocused(index,focused)} onDone={onEditorDone}/>
        {:else}
        <div class="item" bind:this={itemdiv} class:saving class:error class:deleted on:click={onClick}>{@html toHTML(text||placeholder)}</div>
        {/if}
    </div>