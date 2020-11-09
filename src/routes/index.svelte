<style>
	.editor {
		border-left: 2px solid #444;
		margin-bottom: 4px;
        break-inside: avoid-column;
	}
	.editor.focused {
		border-left: 2px solid #aaa;
	}
	.items {
		column-count: auto;
		column-width: 480px;
		column-gap: 4px;
		column-fill: auto;
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
			// return {}
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
	let editingItems = []
	let focusedItem = -1
	let focused = false
	
	items.forEach((item, index)=>item.index=index)
	
	function stableSort(array, compare) {
		return array.map((item, index) => ({item, index}))
		.sort((a, b) => compare(a.item, b.item) || a.index - b.index)
		.map(({item}) => item)
	}
	
	function updateItemIndices() {
		editingItems = []
		focusedItem = -1
		items.forEach((item, index)=>{
			item.index = index
			if (item.editing) editingItems.push(index)
			// if (item.focused) focusedItem = index;
			if (document.activeElement == textArea(index)) focusedItem = index;
		})
		setTimeout(()=>{ // allow dom updated before re-focus
			textArea(focusedItem).focus() // ensure correct focus
			// console.log(`editingItems:${editingItems}, focusedItem:${focusedItem}`)
		},0)
	}
	
	function onEditorChange(text:string) {
		const lowercaseText = text.toLowerCase()
		items = stableSort(items, (a,b) => {
			return (b.editing - a.editing) ||
			(b.text.toLowerCase().indexOf(lowercaseText)<0?0:1) - (a.text.toLowerCase().indexOf(lowercaseText)<0?0:1) ||
			(b.time - a.time) 
		})
		updateItemIndices()
	}
	function onTagClick(tag:string) { 
		editorText = tag + " "
		onEditorChange(editorText)
		textArea(-1).focus()
	}
	
	let editorText = ""
	function onEditorDone(origText:string, e:KeyboardEvent) {
		let text = origText
		// if empty, then we trigger chain saving (e.g. Cmd+S) but not chain backspace
		if (text.length == 0) { 
			if (e.code != "Backspace") focusOnNearestEditingItem(-1); 
			return 
		}
		switch (text) {
			case '/signout': {
				firebase().auth().signOut().then(()=>{console.log("signed out")}).catch(console.error)
				document.cookie = '__session=signed_out;max-age=0'; // delete cookie for server
				location.reload()
				return
			}
			case '/count': {
				text = `${editingItems.length} items are selected`
				break
			}
		}
		// reset editor/query _before_ adding new item
		editorText = ""
		onEditorChange("")
		textArea(-1).focus()
		const item = {time:Date.now(), text:text};
		items = [{...item, saving:true}, ...items]
		updateItemIndices() // for new item
		firestore().collection("items").add(item).then((doc)=>{items[0].saving=false;items[0].id=doc.id})
		.catch((error)=>{console.error(error);items[0].error=true})
	}
	
	function focusOnNearestEditingItem(index:number) {
		let near = Math.min.apply(null, editingItems.filter((i)=>i>index))
		if (near == Infinity) near = Math.max.apply(null, [-1, ...editingItems])
		textArea(near).focus()
		focusedItem = near
	}
	
	function onItemDeleted(index:number) {
		items.splice(index, 1)
		updateItemIndices()
		items = items // trigger dom update
		//setTimeout(()=>focusOnNearestEditingItem(index-1),0)
		textArea(-1).focus() // focus on editor to prevent accidental deletion of saved items
	}
	
	// Sign in user as needed ...
	if (isClient) { // on client
		if (error) { // error from server, attempt reload
			console.log(error)
			// NOTE: reload is disabled for now as it causes an infinite loop in production, possibly due to reload being too disruptive
			// location.reload()
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
	
	function onItemEditing(index:number, editing:boolean) {
		if (editing) {
			editingItems.push(index)
			let item = items[index] // since index may change
			onEditorChange(editorText)
			setTimeout(()=>{ // allow textarea to be created
				// NOTE: this focus does not work on iOS, even though focusOnNearestEditingItem (below) works, possibly because the keyboard is already visible in that case. In any case, the overall behavior on iOS is reasonable since user gets better context after reodering and can manually focus.
				textArea(item.index).focus()
				window.top.scrollTo(0,0)
			},0) // trigger resort
		} else {
			editingItems.splice(editingItems.indexOf(index), 1)
			if (focusedItem == index) {
				focusedItem = -1
				// textArea(-1).focus()
				if (items[index].text.length > 0) { // otherwise handled in onItemDeleted()
					focusOnNearestEditingItem(index)
					onEditorChange(editorText) // update sorting of items
				}
			}
		}
		// console.log(`item ${index} editing: ${editing}, editingItems:${editingItems}, focusedItem:${focusedItem}`)
	}
	
	function onItemFocused(index:number, focused:boolean) {
		if (focused) focusedItem = index
		else focusedItem = -1
		// console.log(`item ${index} focused: ${focused}, focusedItem:${focusedItem}`)
	}
	
	function editItem(index:number) {
		items[index].lastText = items[index].text
		items[index].editing=true
		editingItems.push(index)
	}
	
	function textArea(index:number) : HTMLTextAreaElement {
		return document.getElementById("textarea-" + (index<0 ? "editor" : items[index].id)) as HTMLTextAreaElement
	}
	
	function onPrevItem() {
		if (focusedItem >= 0) {
			const index = focusedItem
			const textarea = textArea(index)
			if (index == 0) textArea(-1).focus()
			else {
				if(!items[index-1].editing) editItem(index-1)
				setTimeout(()=>textArea(index-1).focus(),0)
			}
		}
	}

	function onNextItem() {
		if (focusedItem < items.length-1) {
			const index = focusedItem
			const textarea = textArea(index)
			if(!items[index+1].editing) editItem(index+1)
			setTimeout(()=>textArea(index+1).focus(),0)
		}
	}

</script>

{#if user && allowedUsers.includes(user.uid)}

<div class="items">
	<div style="height:4px"/><!--spacer that does not spill over to other column-->
	<div class="editor" class:focused>
		<Editor bind:text={editorText} bind:focused={focused} onChange={onEditorChange} onDone={onEditorDone} onPrev={onPrevItem} onNext={onNextItem} autofocus={true}/>
	</div>
	{#each items as item}
	<Item onEditing={onItemEditing} onFocused={onItemFocused} onDeleted={onItemDeleted} onTagClick={onTagClick} onPrev={onPrevItem} onNext={onNextItem} bind:text={item.text} bind:lastText={item.lastText} bind:editing={item.editing} bind:focused={item.focused} bind:deleted={item.deleted} {...item}/>
	{/each}
</div>

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