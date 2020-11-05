<style>
	:global(.items > div) {
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
	}
</style>

<script context="module" lang="ts">
	// Preload function can be called on either client or server
	// See https://sapper.svelte.dev/docs#Preloading
	import { firebaseConfig } from '../../firebase.config.js'	
	export async function preload(page, session) {
		let firebaseLibrary = typeof window !== 'undefined' ? window["firebase"] : require("firebase");
		let firebase = firebaseLibrary.apps.length > 0 ? firebaseLibrary.apps[0] : firebaseLibrary.initializeApp(firebaseConfig)
		let items =	await firebase.firestore().collection("items").orderBy("time","desc").get();	
		return {"items": items.docs.map((item)=>item.data())}
	}
	
	let itemsdiv: HTMLDivElement	
	function addNewItem(text) {
		var div = document.createElement('div');
		div.innerText = text;
		div.style.opacity = "0.5";
		itemsdiv.insertBefore(div, itemsdiv.firstChild);
		const item = {time:Date.now(), text:text};
		if (window.firebase.apps.length == 0) window.firebase.initializeApp(firebaseConfig);
		window.firebase.firestore().collection("items").add(item)
		.then(()=>div.style.opacity="1")
		.catch((error)=>console.error(error))
	}
	
</script>

<script lang="ts">
	import Editor from '../components/Editor.svelte';
	export let items = [];
</script>

<Editor newTextHandler={addNewItem}/>

<div class="items" bind:this={itemsdiv}>
	{#each items as item}
	<div>{item.text}</div>
	{/each}
</div>