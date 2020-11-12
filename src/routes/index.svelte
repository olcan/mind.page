<style>
	#loading {
		display: flex;
		min-height: 100vh;
		justify-content: center;
		align-items: center;
		font-size: 2em;
		font-family: Helvetica;
		background: #111 url(/loading.gif) no-repeat center;
		background-size: 30%;
	}
	#header {
		display: flex;
		width: 100%;
		/* margin-right:8px; */
		padding: 4px 0;
		border-left: 2px solid #444;
		margin-bottom: 8px; /* matches right margin of items for column spacing */
		background: #1b1b1b; /* matches unfocused editor */
	}
	#header.focused {
		background: #1b1b1b;
		border-left: 2px solid #aaa;
	}
	#editor {
		/* max-width: 600px; */
		width: 100%;
	}
	.spacer { flex-grow: 1; }
	#user {
		/* display: flexbox; */
		flex: 0 0 48px;
		max-height: 48px;
		margin-left: 4px;
		margin-right: 4px;
		border-radius: 24px;
		background-size: cover !important;
		background: gray;
		cursor: pointer;
	}
	.items {
		column-count: auto;
		column-width: 480px;
		column-gap: 0;
		column-fill: auto;
		/* margin-top: 4px; */
		/* column-width: 600px; */
	}
	.page-separator {
		column-span: all;	
		display: block;
		height: 1px;
		border-top: 1px dashed #444;
		margin: 20px 0;
	}
	/* adapt to smaller windows/devices */
	@media only screen and (max-width: 600px) {
		.items { column-count: 1 }
		.page-separator { display: none }
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
			return {items: items.docs.map((doc)=>Object.assign(doc.data(),{id:doc.id, updateTime:doc.updateTime.seconds, createTime:doc.createTime.seconds}))}
		} else {
			return {error: "invalid session cookie"}
		}
	}
</script>

<script lang="ts">
	import type { write } from 'fs'
	import Editor from '../components/Editor.svelte'
	import Item from '../components/Item.svelte'
	export let items = []
	export let error = null
	let user = null
	let editingItems = []
	let focusedItem = -1
	let focused = false
	
	function itemTimeString(delta:number) {
		if (delta < 60) return ""//"<1m"
		if (delta < 3600) return Math.floor(delta/60).toString() + "m"
		if (delta < 24*3600) return Math.floor(delta/3600).toString() + "h"
		return Math.floor(delta/(24*3600)).toString() + "d"
	}
	
	let indexFromId;
	function updateItemIndices() {
		editingItems = []
		focusedItem = -1
		let prevTime = Infinity
		let prevTimeString = ""
		indexFromId = new Map()
		items.forEach((item, index)=>{
			item.index = index
			indexFromId.set(item.id, index)
			if (item.editing) editingItems.push(index)
			if (item.focused) focusedItem = index;
			// if (document.activeElement == textArea(index)) focusedItem = index;
			
			if (item.pinned) { // ignore time for pinned items
				item.timeString = ""
				item.timeOutOfOrder = false
			} else {
				let timeString = itemTimeString((Date.now() - item.time)/1000)
				item.timeOutOfOrder = (item.time > prevTime) // for special styling
				item.timeString = (timeString == prevTimeString && !item.timeOutOfOrder) ? "" : timeString
				// item.timeString = Math.floor((Date.now() - item.time)/1000).toString()
				prevTimeString = timeString
				prevTime = item.time
			}
			
			// NOTE: although we have heights, the ideal algorithm is unclear so we use simple count-based splitting for now
			// NOTE: one option is to use screen size and split by total height, but it is not obvious we want to fill the screen
			// console.log(item.height)			
			item.page = (index > 0 && index % 10 == 0)
		})
		
		if (focusedItem >= 0) { // maintain focused item
			const textarea = textArea(focusedItem)
			if (textarea) setTimeout(()=>textarea.focus(),0) // allow dom update before refocus
		}
	}
	
	// initialize indices and savedText (as original text returned by server)
	if (isClient) {
		onEditorChange("") // initial sort, index assignment, etc
		items.forEach((item)=>{ item.savedText = item.text })
	}
	
	function stableSort(array, compare) {
		return array.map((item, index) => ({item, index}))
		.sort((a, b) => compare(a.item, b.item) || a.index - b.index)
		.map(({item}) => item)
	}
	
	function matches(str, terms) {
		return terms.map((t)=>str.indexOf(t)>=0).reduce((a,b)=>a+b, 0)
	}

	function onEditorChange(origText:string) {
		const text = origText.toLowerCase().trim()
		const terms = [... new Set(text.split(/\s+/))].filter((t)=>t.length>0)
		let listing = []
		items.forEach((item)=>{
			const lctext = item.text.toLowerCase()
			item.pinned = lctext.match(/(?:^|\s)#pin(?:\/|\s|$)/) ? true : false
			// NOTE: alphanumeric ordering must always be preceded with a prefix match condition
			//       (otherwise the default "" would always be on top unless you use something like "ZZZ")
			item.pinTerm = (lctext.match(/(?:^|\s)#pin\/[\/\w]*(?:\s|$)/) || [""])[0].trim()
			item.prefixMatch = lctext.startsWith(terms[0])
			item.prefixMatchTerm = ""
			if (item.prefixMatch)
				item.prefixMatchTerm = terms[0] + lctext.substring(terms[0].length).match(/^[\/\w]*/)[0]
			// use first exact-match item as listing
			if (item.prefixMatchTerm == terms[0] && listing.length == 0)
				listing = (lctext.match(/(:?^|\s)(#[\/\w]+)/g)||[]).map((t)=>t.trim()).reverse()
			item.matches = matches(lctext, terms)
		})
		// NOTE: undefined values produce NaN, which is treated as 0
		items = stableSort(items, (a, b) => {
			// pinned (contains #pin)
			return (b.pinned - a.pinned) ||
			// alphanumeric ordering on #pin/* term
			(a.pinTerm.localeCompare(b.pinTerm)) ||
			// position in item with exact match on first term
			(listing.indexOf(b.prefixMatchTerm) - listing.indexOf(a.prefixMatchTerm)) ||
			// prefix match on first term
			(b.prefixMatch - a.prefixMatch) ||
			// alphanumeric ordering on prefix-matching term			
			(a.prefixMatchTerm.localeCompare(b.prefixMatchTerm)) ||
			// editing mode
			(b.editing - a.editing) ||
			// # of matching words
			(b.matches - a.matches) ||
			// time (most recent first)
			(b.time - a.time)
		})
		updateItemIndices()
	}
	function onTagClick(tag:string) {
		editorText = (editorText.trim() + " " + tag).trim() + " "
		onEditorChange(editorText)
		// NOTE: refocusing on editor can be annoying on mobile due to keyboard
		textArea(-1).focus()
		window.top.scrollTo(0,0)
	}
	
	function signOut() {
		firebase().auth().signOut().then(()=>{console.log("signed out")}).catch(console.error)
		document.cookie = '__session=signed_out;max-age=0'; // delete cookie for server
		location.reload()		
	}
	
	let editorText = ""
	function onEditorDone(text:string, e:KeyboardEvent) {
		// NOTE: text is already trimmed for onDone
		if (e.code == "Backspace") return // ignore backspace
		let editing = true // created item can be editing or not
		switch (text) {
			case '/signout': { signOut(); return }
			case '/count': { text = `${editingItems.length} items are selected`; break }
			case '/times': { 
				if (editingItems.length == 0) { text="no item selected"; break }
				let item = items[editingItems[0]];
				text = `${new Date(item.time)}\n${new Date(item.updateTime)}\n${new Date(item.createTime)}`;
				break
			}
			case '/tweet': {
				if (editingItems.length == 0) { alert("/tweet: no item selected"); return }
				if (editingItems.length > 1) { alert("/tweet: too many items selected"); return }
				let item = items[editingItems[0]]
				location.href = "twitter://post?message=" + encodeURIComponent(item.text)
				return
			}
			default: {
				if (text.startsWith("/")) { text = `unknown command ${text}`; break }
				editing = text.length == 0 // if text is empty, continue editing
			}
		}
		let tmpid = Date.now().toString()
		let itemToSave = {time:Date.now(), text:text}
		let item = {...itemToSave, id:tmpid, saving:true, editing:editing};
		items = [item, ...items]
		editorText = ""
		onEditorChange(editorText)
		if (editing) setTimeout(()=>textArea(indexFromId.get(tmpid)).focus(),0)
		else textArea(-1).focus()
		
		firestore().collection("items").add(itemToSave).then((doc)=>{
			let index = indexFromId.get(tmpid) // since index can change
			if (index == undefined) { // item was deleted before it could be saved
				doc.delete().catch(console.error)
				return
			}
			items[index].saving = false // assigning to item object in array triggers dom update for item
			items[index].savedText = text
			items[index].id = doc.id
			indexFromId.set(doc.id, index)
			indexFromId.delete(tmpid)
			// also save to items-history ...
			firestore().collection("items-history").add({item:doc.id, ...itemToSave}).catch(console.error)		
		})
		.catch((error)=>{console.error(error);items[0].error=true})
	}
	
	function focusOnNearestEditingItem(index:number) {
		// console.log("focusOnNearestEditingItem, editingItems",editingItems)
		let near = Math.min.apply(null, editingItems.filter((i)=>i>index))
		if (near == Infinity) near = Math.max.apply(null, [-1, ...editingItems])
		focusedItem = near
		textArea(near).focus()
		// NOTE: a second dispatched focus() call can sometimes be necessary 
		//       (e.g. if you unpin/save a pinned item and refocus on some item below)
		setTimeout(()=>textArea(near).focus(), 0)
		// console.log("focusing on ",near,"from",index)
	}
	
	function onItemDeleted(index:number) {
		items.splice(index, 1)
		updateItemIndices()
		items = items // trigger dom update
		setTimeout(()=>focusOnNearestEditingItem(index-1),0)
		//textArea(-1).focus() // focus on editor to prevent accidental deletion of saved items
	}

	function onItemSaved(id:string) {
		const index = indexFromId.get(id)
		if (index == undefined) return // item was deleted
		items[index].savedText = items[index].text
		items[index].saving = false
	}

	function onItemHeight(id:string, height:number) {
		const index = indexFromId.get(id)
		if (index == undefined) return // item was deleted
		items[index].height = height
	}
	
	// Sign in user as needed ...
	if (isClient) {
		if (error) console.log(error) // log server-side error
		// NOTE: test server-side error with document.cookie='__session=signed_out;max-age=0';
		firebase().auth().onAuthStateChanged(authUser => {
			if (authUser) { // user logged in
				user = authUser;
				console.log("signed in", user.email)
				
				// Store user's ID token as a 1-hour __session cookie to send to server for preload
				// NOTE: __session is the only cookie allowed by firebase for efficient caching
				//       (see https://stackoverflow.com/a/44935288)
				user.getIdToken(false/*force refresh*/).then((token)=>{
					document.cookie = '__session=' + token + ';max-age=86400';
					console.log("updated cookie", error || ", no error")
					// reload with new cookie if we are on error page
					if (error) location.reload()
				}).catch(console.error)
				
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
					console.log("signed in after redirect", error || ", no error")
					// reload if we are on an error page
					// NOTE: this can lead to infinite loop if done without some delay
					// if (error) location.reload()
					// setTimeout(()=>{if (error) location.reload()}, 1000)					
				}).catch(console.error)
			}
		})
	}
	
	function onItemEditing(index:number, editing:boolean) {
		if (editing) { // started editing
			editingItems.push(index)
			let item = items[index] // since index may change
			onEditorChange(editorText)
			setTimeout(()=>{ // allow textarea to be created
				// NOTE: this focus does not work on iOS, even though focusOnNearestEditingItem (below) works, possibly because the keyboard is already visible in that case. In any case, the overall behavior on iOS is reasonable since user gets better context after reodering and can manually focus.
				textArea(item.index).focus()
				if (item.index < index) window.top.scrollTo(0,0) // scroll to top if item was moved up
			},0) // trigger resort
			
		} else { // stopped editing
			editingItems.splice(editingItems.indexOf(index), 1)
			if (focusedItem == index) {
				focusedItem = -1
				// textArea(-1).focus()
				if (items[index].text.length > 0) { // otherwise handled in onItemDeleted()
					onEditorChange(editorText) // update sorting of items
					focusOnNearestEditingItem(index)
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
		items[index].editing=true
		editingItems.push(index)
	}
	
	function textArea(index:number) : HTMLTextAreaElement {
		return document.getElementById("textarea-" + (index<0 ? "editor" : items[index].id)) as HTMLTextAreaElement
	}
	
	function onPrevItem(inc=-1) {
		if (focusedItem + inc < -1) return
		const index = focusedItem
		const textarea = textArea(index)
		if (index+inc == -1) textArea(-1).focus()
		else {
			if(!items[index+inc].editing) {
				if (items[index+inc].pinned) { onPrevItem(inc-1); return } // skip if pinned
				editItem(index+inc)
			}
			setTimeout(()=>textArea(index+inc).focus(),0)
		}
	}
	
	function onNextItem(inc=1) {
		if (focusedItem + inc >= items.length) return
		const index = focusedItem
		const textarea = textArea(index)
		if(!items[index+inc].editing) {
			if (items[index+inc].pinned) { onNextItem(inc+1); return } // skip if pinned
			editItem(index+inc)
		}
		setTimeout(()=>textArea(index+inc).focus(),0)
	}
	
	function disableSaveShortcut(e:KeyboardEvent) {
		// disable save shortcuts, focus on editor instead
		if (focusedItem >= 0) return // already focused on an item
		if ((e.code == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) || (e.code == "KeyS" && (e.metaKey || e.ctrlKey))) {
			e.preventDefault()
			textArea(-1).focus()
			window.top.scrollTo(0,0)
		}
	}

	function resizeEditor() {
		// console.log("resizing editor ...")
		// let editor = document.getElementById("editor");
		// let firstItem = document.getElementsByClassName("item")[0];
		// if (editor && firstItem && firstItem.clientWidth > 0) {
		// 	let maxWidth = firstItem.clientWidth + 'px'
		// 	if (editor.style.maxWidth != maxWidth) editor.style.maxWidth = maxWidth
		// }
	}

	// NOTE: editor maxWidth must be managed if it is placed outside .items
	// NOTE: periodic resize is the only simple and reliable way to handle iOS font size changes
	// import { onMount, onDestroy, afterUpdate } from 'svelte';
	// afterUpdate(resizeEditor) // NOTE: onMount is insufficient since items are updated
	// let resizeIntervalID;
	// onMount(()=>{resizeIntervalID = setInterval(resizeEditor, 1000)})
	// onDestroy(()=>{clearInterval(resizeIntervalID)})

	// global helper functions for javascript:... shortcuts
	if (isClient) { // functions for client use
		window["_replace"] = function(text:string) {
			onEditorChange(editorText = text)
		}
		window["_replace_edit"] = function(text:string) { 
			onEditorChange(editorText = (text + " ").trimStart())
			textArea(-1).focus()
		}
		window["_append"] = function(text:string) {			
			onEditorChange(editorText = (editorText.trim() + " " + text).trimStart())
		}
		window["_append_edit"] = function(text:string) {
			onEditorChange(editorText = (editorText.trim() + " " + text).trim() + " ")
			textArea(-1).focus()
		}
		window["_enter"] = function(text:string) {
			onEditorDone(text, null)
		}
		window["_text"] = function() { return editorText.trim() }
		window["_encoded_text"] = function() { return encodeURIComponent(editorText.trim()) }
		window["_google"] = function() { 
			window.open('https://google.com/search?q='+encodeURIComponent(editorText.trim()))
		}
		window["_tweet"] = function() {
			if (editorText.trim() == "") { onEditorDone("/tweet", null) } 
			else { location.href = "twitter://post?message=" + encodeURIComponent(editorText.trim()) }
		}
	}

</script>

{#if user && allowedUsers.includes(user.uid) && !error}
<!-- all good! user logged in, has permissions, and no error from server -->

<div class="items">
	<div id="header" class:focused on:click={()=>textArea(-1).focus()}>
		<div id="editor">
			<Editor bind:text={editorText} bind:focused={focused} onChange={onEditorChange} onDone={onEditorDone} onPrev={onPrevItem} onNext={onNextItem} autofocus={true}/>
		</div>
		<div class="spacer"/>
		<div id="user" style="background-image: url({user.photoURL})" on:click={signOut}/>
	</div>
	
	{#each items as item}
	{#if item.page}<div class="page-separator"/>{/if}
	<!-- WARNING: Binding does not work for asynchronous updates since the underlying component may be destroyed -->
	<!-- TODO: reconsider for saving, savedText, and height; problem may be initialization, test for saving first -->
	<Item onEditing={onItemEditing} onFocused={onItemFocused} onDeleted={onItemDeleted} onSavedAsync={onItemSaved} onHeightAsync={onItemHeight} onTagClick={onTagClick} onPrev={onPrevItem} onNext={onNextItem} bind:text={item.text} bind:editing={item.editing} bind:focused={item.focused} bind:deleted={item.deleted} bind:saving={item.saving} bind:savedText={item.savedText} bind:height={item.height} bind:time={item.time} id={item.id} index={item.index} itemCount={items.length} timeString={item.timeString} timeOutOfOrder={item.timeOutOfOrder} updateTime={item.updateTime} createTime={item.createTime}/>
	{/each}
</div>

{:else if user && !allowedUsers.includes(user.uid)} <!-- user logged in but not allowed -->
User {user.email} not allowed.

{:else if error} <!-- user logged in, has permissions, but server returned error -->
<div id='loading'/>
{:else if !user && !error} <!-- user not logged in and no errors from server yet (login in progress) -->
<div id='loading'/>
{:else} <!-- should not happen -->
?

{/if}

<svelte:window on:keypress={disableSaveShortcut} on:resize={resizeEditor}/>