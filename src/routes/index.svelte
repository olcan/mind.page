<script context="module" lang="ts">
	// Preload function can be called on either client or server
	// See https://sapper.svelte.dev/docs#Preloading
	import { firestore } from '../../firebase.js'
	export async function preload(page, session) {
		let items =	await firestore().collection("items").orderBy("time","desc").get();	
		return {items: items.docs.map((doc)=>Object.assign(doc.data(),{id:doc.id}))}
	}
</script>

<script lang="ts">
	import Editor from '../components/Editor.svelte'; 
	import Item from '../components/Item.svelte';
	export let items = [];

	function onEditorDone(text:string) {
		const item = {time:Date.now(), text:text};
		items = [{...item, saving:true}, ...items]
		firestore().collection("items").add(item).then((doc)=>{items[0].saving=false;items[0].id=doc.id})
		.catch((error)=>{console.error(error);items[0].error=true})
	}
</script>

<Editor onDone={onEditorDone}/>
{#each items as item}
<Item {...item}/>
{/each}