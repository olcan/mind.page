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
	}
</style>

<script context="module">
	// Preload function can be called on either client or server
	// See https://sapper.svelte.dev/docs#Preloading
	import { firebaseConfig } from '../../firebase.config.js'	
	export async function preload(page, session) {
		let firebaseLibrary = typeof window !== 'undefined' ? window["firebase"] : require("firebase");
		let firebase = firebaseLibrary.apps.length > 0 ? firebaseLibrary.apps[0] : firebaseLibrary.initializeApp(firebaseConfig)
		let items =	await firebase.firestore().collection("items").orderBy("time","desc").get();	
		return {"items": items.docs.map((item)=>item.data())}
	}
</script>

<script>
	import Editor from '../components/Editor.svelte';
	export let items = [];
</script>

<Editor/>

{#each items as item}
<div class="item">{item.text}</div>
{/each}