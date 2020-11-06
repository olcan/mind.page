<style>
	.item {
		color: #ddd;
		width: 100%;
		background: transparent;
		margin: 0;
		padding: 10px;
		box-sizing: border-box;
		white-space: pre-wrap;
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
</style>

<script lang="ts">
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
            firestore().collection("items").doc(id).delete().then(()=>{saving=false;deleted=true})
            .catch((error)=>{console.error(error);error=true})
        } else { // update
            firestore().collection("items").doc(id).update(item).then(()=>{saving=false})
            .catch((error)=>{console.error(error);error=true})
        }
    }
    function onClick() { editing = !editing }

</script>

{#if editing}
    <Editor text={text} onDone={onEditorDone}/>
{:else}
    <div class="item" class:saving class:error class:deleted on:click={onClick}>{text||placeholder}</div>
{/if}