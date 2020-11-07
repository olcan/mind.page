<style>
	.editor {
		border-left: 2px solid #eee;
		margin-bottom: 5px;
	}
</style>

<script context="module" lang="ts">	
	import { isClient, firebase, firestore, firebaseConfig, firebaseAdmin } from '../../firebase.js'
	const allowedUsers = ["y2swh7JY2ScO5soV7mJMHVltAOX2"] // user.uid for olcans@gmail.com
	
	// NOTE: Preload function can be called on either client or server
	// See https://sapper.svelte.dev/docs#Preloading
	export async function preload(page, session) {
		// NOTE: for development server, admin credentials require `gcloud auth application-default login`
		const user:any = await firebaseAdmin().auth().verifyIdToken(session.cookie).catch(console.error)
		if (user && allowedUsers.includes(user.uid)) {
			let items =	await firebaseAdmin().firestore().collection("items").orderBy("time","desc").get()
			return {items: items.docs.map((doc)=>Object.assign(doc.data(),{id:doc.id}))}
		} else {
			return {error: "invalid session cookie"}
		}
	}
</script>

<script lang="ts">
	import Editor from '../components/Editor.svelte'
	import Item from '../components/Item.svelte'
	export let items = []
	export let error = null
	let user = null
	
	function stableSort(array, compare) {
		return array.map((item, index) => ({item, index}))
		.sort((a, b) => compare(a.item, b.item) || a.index - b.index)
		.map(({item}) => item)
	}
	
	function onEditorChange(text:string) {		
		items = stableSort(items, (a,b) => {
			return (b.editing - a.editing) ||
			(b.text.indexOf(text)<0?0:1) - (a.text.indexOf(text)<0?0:1) ||
			(b.time - a.time) 
		})
	}	
	function onTagClick(tag:string) { onEditorChange(tag) }
	
	function onEditorDone(text:string) {
		if (text.length == 0) return
		if (text == "/signout") {
			firebase().auth().signOut().then(()=>{console.log("signed out")}).catch(console.error)
			document.cookie = '__session=signed_out;max-age=0'; // delete cookie for server
			location.reload()
			return
		}
		const item = {time:Date.now(), text:text};
		items = [{...item, saving:true}, ...items]
		firestore().collection("items").add(item).then((doc)=>{items[0].saving=false;items[0].id=doc.id})
		.catch((error)=>{console.error(error);items[0].error=true})
	}
	
	// Sign in user as needed ...
	if (isClient) { // on client
		if (error) { // error from server, attempt reload
			console.log(error)
			location.reload()
		}
		// user = JSON.parse(window.localStorage.getItem("user"))
		firebase().auth().onAuthStateChanged(authUser => {
			if (authUser) { // user logged in
				user = authUser;				
				// Store user's ID token as a 1-hour __session cookie to send to server for preload
				// NOTE: __session is the only cookie allowed by firebase for efficient caching
				//       (see https://stackoverflow.com/a/44935288)
				user.getIdToken(false/*force refresh*/).then((token)=>{
					const isNew = (document.cookie.indexOf("__session") < 0)
					document.cookie = '__session=' + token + ';max-age=86400';
					if (isNew) location.reload() // trigger preload w/ cookie
				}).catch(console.error)
				//localStorage.setItem("user",JSON.stringify(user))
				
			} else {
				// return // test signed out state
				let provider = new window.firebase.auth.GoogleAuthProvider()
				firebase().auth().useDeviceLanguage()
				// firebase().auth().setPersistence("none")
				// firebase().auth().setPersistence("session")
				firebase().auth().setPersistence("local")
				firebase().auth().signInWithRedirect(provider)
				firebase().auth().getRedirectResult().then((result) => {
					user = result.user
					//localStorage.setItem("user",JSON.stringify(user))
				}).catch(console.error)
			}
		})
	}
</script>

{#if user && allowedUsers.includes(user.uid)}
<div class="editor">
	<Editor onChange={onEditorChange} onDone={onEditorDone}/>
</div>
{#each items as item}
<Item onTagClick={onTagClick} bind:text={item.text} bind:editing={item.editing} {...item}/>
{/each}
{:else if user}
User {user.email} not allowed.
{:else}
<!-- Signing in ... -->
<script>
	if (document.cookie.indexOf("__session")<0) { 
		console.log("Signing in ...")
		document.querySelector('#sapper').innerHTML = "Signing in ..."
	}
</script>
{/if}