<style>
	.item {
		color: #ddd;
		width: 100%;
		background: transparent;
        margin: 2px 0;
		padding: 10px;
		box-sizing: border-box;
		/* white-space: pre-wrap; */
		word-wrap: break-word; 
		font-family: Helvetica;
		font-size: 1.3em;
        line-height: 1.4em;
        cursor: pointer;
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
    import Editor from './Editor.svelte'
    export let editing = false
    export let saving = false
    export let deleted = false
    export let id: string
    export let time: number
    export let text = ""
    const placeholder = " "
    let error = false

    import { firestore } from '../../firebase.js'
    function onEditorDone(editorText:string) {
        editing = false
        if (text.trim().length > 0 && text == editorText) return // no change
        text = editorText
        // time = Date.now()
        saving = true
        const item = {time:time, text:text};
        
        if (text.trim().length == 0) { // delete
            deleted=true /* reflect immediately, since failure is not too serious */
            firestore().collection("items").doc(id).delete().then(()=>{saving=false})
            .catch((error)=>{console.error(error);error=true})
        } else { // update
            firestore().collection("items").doc(id).update(item).then(()=>{saving=false})
            .catch((error)=>{console.error(error);error=true})
        }
    }
    function onClick() { editing = !editing }

    let itemdiv: HTMLDivElement
    import { afterUpdate } from 'svelte';
    afterUpdate(()=>{
        if (itemdiv != null) // null if item is removed
         window["MathJax"].typesetPromise([itemdiv])
    }); // perform initial sizing for divs below editor

</script>

{#if editing}
    <Editor text={text} onDone={onEditorDone}/>
{:else}
    <div class="item" bind:this={itemdiv} class:saving class:error class:deleted on:click={onClick}>{@html marked(text||placeholder)}</div>
{/if}