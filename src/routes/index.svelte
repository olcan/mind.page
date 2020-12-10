<script context="module" lang="ts">
  import { isClient, firebase, firestore, firebaseConfig, firebaseAdmin } from "../../firebase.js";
  const allowedUsers = ["y2swh7JY2ScO5soV7mJMHVltAOX2"]; // user.uid for olcans@gmail.com

  // NOTE: Preload function can be called on either client or server
  // See https://sapper.svelte.dev/docs#Preloading
  export async function preload(page, session) {
    // console.log("preloading, client?", isClient);
    // NOTE: for development server, admin credentials require `gcloud auth application-default login`
    const user: any = await firebaseAdmin().auth().verifyIdToken(session.cookie).catch(console.error);
    if (user && allowedUsers.includes(user.uid)) {
      let items = await firebaseAdmin().firestore().collection("items").orderBy("time", "desc").get();
      // return {}
      return {
        items: items.docs.map((doc) =>
          Object.assign(doc.data(), {
            id: doc.id,
            updateTime: doc.updateTime.seconds,
            createTime: doc.createTime.seconds,
          })
        ),
      };
    } else {
      return { error: "invalid session cookie" };
    }
  }
</script>

<script lang="ts">
  import Editor from "../components/Editor.svelte";
  import Item from "../components/Item.svelte";
  export let items = [];
  export let error = null;
  let user = null;
  let loggedIn = false;
  let deletedItems = [];
  let editingItems = [];
  let focusedItem = -1;
  let focused = false;
  let editorBlurTime = 0;

  function onEditorFocused(focused: boolean) {
    if (!focused) editorBlurTime = Date.now();
  }

  function itemTimeString(delta: number) {
    if (delta < 60) return ""; //"<1m"
    if (delta < 3600) return Math.floor(delta / 60).toString() + "m";
    if (delta < 24 * 3600) return Math.floor(delta / 3600).toString() + "h";
    return Math.floor(delta / (24 * 3600)).toString() + "d";
  }

  let indexFromId;
  let indicesFromLabel;
  let headerdiv;
  let consolediv;
  let dotCount = 0;
  let columnCount = 0;
  function updateItemLayout() {
    editingItems = [];
    focusedItem = -1;
    let prevTime = Infinity;
    let prevTimeString = "";
    indexFromId = new Map();
    indicesFromLabel = new Map();
    let timeString = "";
    dotCount = 0;
    // NOTE: we use document width as it scales with font size consistently on iOS and Mac
    const documentWidth = document.documentElement.clientWidth;
    const minColumnWidth = 500; // minimum column width for multiple columns
    columnCount = Math.max(1, Math.floor(documentWidth / minColumnWidth));
    let columnHeights = new Array(columnCount).fill(0);
    let columnItems = new Array(columnCount).fill(0);
    columnHeights[0] = headerdiv ? headerdiv.offsetHeight : 0; // first column includes header
    columnHeights[0] -= consolediv && consolediv.style.display == "block" ? consolediv.offsetHeight : 0; // exclude console since temporary

    items.forEach((item, index) => {
      item.index = index;
      indexFromId.set(item.id, index);
      if (item.dotted) dotCount++;
      if (item.tmpid) indexFromId.set(item.tmpid, index);
      if (item.label) {
        indicesFromLabel.set(item.label, [...(indicesFromLabel.get(item.label) || []), index]);
      }
      if (item.editing) editingItems.push(index);
      if (item.focused) focusedItem = index;
      // if (document.activeElement == textArea(index)) focusedItem = index;

      if (item.pinned) {
        // ignore time for pinned items
        item.timeString = "";
        item.timeOutOfOrder = false;
      } else {
        timeString = itemTimeString((Date.now() - item.time) / 1000);
        item.timeOutOfOrder = item.time > prevTime; // for special styling
        item.timeString = timeString == prevTimeString && !item.timeOutOfOrder ? "" : timeString;
        // item.timeString = Math.floor((Date.now() - item.time)/1000).toString()
        prevTimeString = timeString;
        prevTime = item.time;
      }

      // determine item column
      item.nextColumn = -1;
      item.nextItemInColumn = -1;
      item.outerHeight = (item.height || 100) + 8 + (item.timeString ? 24 : 0); // item + margins + time string
      if (index == 0) item.column = 0;
      else {
        // stay on same column unless column height would exceed minimum column height by 90% of screen height
        const lastColumn = items[index - 1].column;
        const minColumnHeight = Math.min(...columnHeights);
        if (
          columnHeights[lastColumn] <= minColumnHeight + 0.5 * outerHeight ||
          columnHeights[lastColumn] + item.outerHeight + 40 <= minColumnHeight + 0.9 * outerHeight
        )
          item.column = lastColumn;
        else item.column = columnHeights.indexOf(minColumnHeight);
        if (item.column != lastColumn) {
          items[index - 1].nextColumn = item.column;
          columnHeights[lastColumn] += 40; // .section-separator height including margins
        }
      }
      columnHeights[item.column] += item.outerHeight;
      items[columnItems[item.column]].nextItemInColumn = index;
      columnItems[item.column] = item.index;
    });

    if (focusedItem >= 0) {
      // maintain focus on item
      const textarea = textArea(focusedItem);
      if (textarea) setTimeout(() => textarea.focus(), 0); // allow dom update before refocus
    } else {
      // refocus on editor if it was unfocused within last .25 seconds
      if (Date.now() - editorBlurTime < 250) textArea(-1).focus();
    }
  }

  function stableSort(array, compare) {
    return array
      .map((item, index) => ({ item, index }))
      .sort((a, b) => compare(a.item, b.item) || a.index - b.index)
      .map(({ item }) => item);
  }

  function itemTags(lctext): Array<string> {
    return Array.from(lctext.matchAll(/(?:^|\s)(#[^#\s<>,.;]+)/g), (m) => m[1].replace(/^#_/, "#"));
  }

  // NOTE: Invoke onEditorChange only editor text and/or item content has changed.
  //       Invoke updateItemLayout directly if only item sizes have changed.
  const editorDebounceTime = 500;
  let lastEditorChangeTime = 0;
  let matchingItemCount = 0;
  let editorChangePending = false;
  function onEditorChange(text: string) {
    // if editor has focus and it is too soon since last change/return, debounce
    if (document.activeElement == textArea(-1) && Date.now() - lastEditorChangeTime < editorDebounceTime) {
      lastEditorChangeTime = Date.now(); // reset timer at each postponed change
      if (!editorChangePending) {
        editorChangePending = true;
        setTimeout(() => {
          editorChangePending = false;
          onEditorChange(editorText);
        }, editorDebounceTime);
      }
      return;
    }
    lastEditorChangeTime = Infinity; // force minimum wait for next change

    text = text.toLowerCase().trim();
    // let terms = [...new Set(text.split(/[^#\/\w]+/))].filter((t) => t);
    let terms = [...new Set(text.split(/\s+/).concat(text.split(/[.,!$%\^&\*;:{}=\-`~()]/)))]
      .concat(itemTags(text))
      .filter((t) => t);
    if (text.startsWith("/")) terms = [];
    let termsSecondary = [];
    terms.forEach((term) => {
      if (term[0] != "#") return;
      let pos;
      let tag = term;
      while ((pos = tag.lastIndexOf("/")) >= 0) termsSecondary.push((tag = tag.slice(0, pos)));
    });

    matchingItemCount = 0;
    // let matchingTermCounts = new Map<string, number>();
    let listing = [];
    items.forEach((item) => {
      const lctext = item.text.toLowerCase();
      item.tags = itemTags(lctext);
      // first tag is taken as "label" if it is the first text in the item
      item.label = lctext.startsWith(item.tags[0]) ? item.tags[0] : "";

      // NOTE: alphanumeric ordering (e.g. on pinTerm) must always be preceded with a prefix match condition
      //       (otherwise the default "" would always be on top unless you use something like "ZZZ")
      const pintags = item.tags.filter((t) => t.match(/^#pin(?:\/|$)/));
      item.pinned = pintags.length > 0;
      item.pinTerm = pintags[0] || "";
      item.dotted = pintags.findIndex((t) => t.match(/^#pin\/dot(?:\/|$)/)) >= 0;
      item.dotTerm = pintags.filter((t) => t.match(/^#pin\/dot(?:\/|$)/))[0] || "";
      item.prefixMatch = lctext.startsWith(terms[0]);
      item.prefixMatchTerm = "";
      if (item.prefixMatch) {
        item.prefixMatchTerm = terms[0] + lctext.substring(terms[0].length).match(/^[\/\w]*/)[0];
      }
      // use first exact-match (=label-match) item as "listing" item
      // (in reverse order so that last is best and default (-1) is worst, and excludes listing item itself)
      if (item.label == terms[0] && listing.length == 0)
        listing = item.tags
          .reverse()
          .filter((t) => t != terms[0])
          .concat([item.label]);

      item.matchingTerms = [];
      if (item.pinned) {
        // match only tags for pinned items
        // item.matchingTerms = terms.filter((t) => item.tags.indexOf(t) >= 0);
        item.matchingTerms = terms.filter((t) => item.tags.findIndex((tag) => tag.startsWith(t)) >= 0);
      } else {
        item.matchingTerms = terms.filter((t) => lctext.indexOf(t) >= 0);
      }
      if (item.matchingTerms.length > 0) matchingItemCount++;
      item.matchingTermsSecondary = [];
      item.matchingTermsSecondary = termsSecondary.filter((t) => lctext.indexOf(t) >= 0);

      item.runnable = lctext.match(/\s*```js_input\s/);
    });

    // Update times for editing items to maintain their ordering when one is saved
    let now = Date.now();
    items.forEach((item) => {
      if (item.editing && !item.text.match(/(?:^|\s)#log(?:\s|$)/)) item.time = now;
    });

    // NOTE: undefined values produce NaN, which is treated as 0
    items = stableSort(items, (a, b) => {
      // pinned (contains #pin)
      return (
        b.dotted - a.dotted ||
        // alphanumeric ordering on #pin/dot/* term
        a.dotTerm.localeCompare(b.dotTerm) ||
        b.pinned - a.pinned ||
        // alphanumeric ordering on #pin/* term
        a.pinTerm.localeCompare(b.pinTerm) ||
        // position in item with exact match on first term
        listing.indexOf(b.prefixMatchTerm) - listing.indexOf(a.prefixMatchTerm) ||
        // prefix match on first term
        b.prefixMatch - a.prefixMatch ||
        // alphanumeric ordering on prefix-matching term
        a.prefixMatchTerm.localeCompare(b.prefixMatchTerm) ||
        // // editing mode
        // b.editing - a.editing ||
        // # of matching words
        b.matchingTerms.length - a.matchingTerms.length ||
        // # of matching secondary words
        b.matchingTermsSecondary.length - a.matchingTermsSecondary.length ||
        // time (most recent first)
        b.time - a.time
      );
    });
    updateItemLayout();
    lastEditorChangeTime = Infinity; // force minimum wait for next change
    if (items.length > 0) setTimeout(updateDotted, 0); // show/hide dotted/undotted items
  }

  function onTagClick(tag: string, e: MouseEvent) {
    // calculate partial tag prefix (e.g. #tech for #tech/math) based on position of click
    let range = document.caretRangeFromPoint(
      e.pageX - document.documentElement.scrollLeft,
      e.pageY - document.documentElement.scrollTop
    );
    if (range) {
      let tagNode = e.target as Node;
      // if target is not the tag node, it must be a highlight, so we move to the parent
      if ((tagNode as HTMLElement).tagName != "MARK") tagNode = tagNode.parentNode;
      // console.log("tag click: ", range.startOffset, clickNode, tagNode.childNodes);
      // if tag node contains highlight, we have to adjust click position
      let pos = range.startOffset;
      for (const child of Array.from(tagNode.childNodes)) {
        if (child.contains(range.startContainer)) break;
        pos += child.textContent.length;
      }
      // we only take partial tag if the current tag is "selected" (i.e. full exact match)
      // (makes it easier to click on tags without accidentally getting a partial tag)
      if ((tagNode as HTMLElement).classList.contains("selected"))
        tag = tag.substring(0, pos) + tag.substring(pos).match(/^[^\/]*/)[0];
    } else {
      console.warn("got null range for tag click: ", tag, e);
    }
    editorText = editorText.trim() == tag ? "" : tag + " "; // space in case more text is added
    onEditorChange(editorText);
    window.top.scrollTo(0, 0);
  }

  function signOut() {
    firebase()
      .auth()
      .signOut()
      .then(() => {
        console.log("signed out");
      })
      .catch(console.error);
    document.cookie = "__session=signed_out;max-age=0"; // delete cookie for server
    location.reload();
  }

  let editorText = "";
  function onEditorDone(text: string, e: KeyboardEvent = null) {
    // NOTE: text is already trimmed for onDone
    if (e && e.code == "Backspace") {
      // just clear and return
      lastEditorChangeTime = 0; // disable debounce even if editor focused
      onEditorChange((editorText = ""));
      return;
    }
    let editing = true; // created item can be editing or not
    let time = Date.now(); // default time is current, can be past if undeleting
    switch (text) {
      case "/signout": {
        signOut();
        return;
      }
      case "/count": {
        text = `${editingItems.length} items are selected`;
        break;
      }
      case "/times": {
        if (editingItems.length == 0) {
          alert("/times: no item selected");
          return;
        }
        let item = items[editingItems[0]];
        text = `${new Date(item.time)}\n${new Date(item.updateTime)}\n${new Date(item.createTime)}`;
        break;
      }
      case "/tweet": {
        if (editingItems.length == 0) {
          alert("/tweet: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/tweet: too many items selected");
          return;
        }
        let item = items[editingItems[0]];
        location.href = "twitter://post?message=" + encodeURIComponent(item.text);
        return;
      }
      case "/duplicate": {
        if (editingItems.length == 0) {
          alert("/duplicate: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/duplicate: too many items selected");
          return;
        }
        let item = items[editingItems[0]];
        time = item.time;
        text = item.text;
        editing = true;
        break;
      }
      case "/undelete": {
        if (deletedItems.length == 0) {
          alert("/undelete: nothing to undelete (in this session)");
          return;
        }
        time = deletedItems[0].time;
        text = deletedItems[0].text;
        deletedItems.shift();
        editing = false;
        break;
      }
      default: {
        if (text.match(/\/js(\s|$)/)) {
          text = "```js_input\n" + text.replace(/\/js\s+/s, "").trim() + "\n```";
        } else if (text.match(/^\/\w+/)) {
          alert(`unknown command ${text.match(/^\/\w+/)[0]}`);
          return;
        } else if (text.match(/^\/\s+/s)) {
          text = text.replace(/^\/\s+/s, "");
        }
        editing = text.length == 0; // if text is empty, continue editing
      }
    }
    let tmpid = Date.now().toString();
    let itemToSave = { time: time, text: text };
    let item = { ...itemToSave, id: tmpid, tmpid: tmpid, saving: true, editing: editing };
    items = [item, ...items];
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange((editorText = "")); // integrate new item at index 0
    // NOTE: if not editing, append JS output and trigger another layout if necessary
    if (!editing) {
      itemToSave.text = item.text = appendJSOutput(text, indexFromId.get(tmpid));
      if (item.text != text) {
        // invoke onEditorChange again due to text change
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange("");
      }
    }
    textArea(-1).focus(); // refocus (necessary on iOS for shifting focus to another item)
    if (editing) setTimeout(() => textArea(indexFromId.get(tmpid)).focus(), 0);

    firestore()
      .collection("items")
      .add(itemToSave)
      .then((doc) => {
        let index = indexFromId.get(tmpid); // since index can change
        if (index == undefined) {
          // item was deleted before it could be saved
          doc.delete().catch(console.error);
          return;
        }
        let textarea = textArea(index);
        let selectionStart = textarea ? textarea.selectionStart : 0;
        let selectionEnd = textarea ? textarea.selectionEnd : 0;
        items[index].id = doc.id;
        indexFromId.set(doc.id, index);
        // NOTE: we maintain mapping from tmpid in case there is async JS with $id plugged in
        //       (also for render-time <script> tags, toHTML (Item.svelte) will continue to plug in tmpid for session)
        indexFromId.set(tmpid, index);
        onItemSaved(doc.id);

        if (focusedItem == index)
          // maintain focus (and caret placement) through id/element change
          setTimeout(() => {
            let index = indexFromId.get(doc.id);
            if (index == undefined) return;
            let textarea = textArea(index);
            if (!textarea) return;
            textarea.selectionStart = selectionStart;
            textarea.selectionEnd = selectionEnd;
            textarea.focus();
          }, 0);
        // also save to items-history ...
        firestore()
          .collection("items-history")
          .add({ item: doc.id, ...itemToSave })
          .catch(console.error);
      })
      .catch((error) => {
        let index = indexFromId.get(tmpid); // since index can change
        console.error(error);
        items[index].error = true;
      });
  }

  function focusOnNearestEditingItem(index: number) {
    // console.log("focusOnNearestEditingItem, editingItems",editingItems)
    let near = Math.min(...editingItems.filter((i) => i > index));
    if (near == Infinity) near = Math.max(...[-1, ...editingItems]);
    focusedItem = near;
    textArea(near).focus();
    // NOTE: a second dispatched focus() call can sometimes be necessary
    //       (e.g. if you unpin/save a pinned item and refocus on some item below)
    setTimeout(() => textArea(near).focus(), 0);
    // console.log("focusing on ",near,"from",index)
  }

  function onItemSaved(id: string) {
    // console.log("saved item", id);
    const index = indexFromId.get(id);
    if (index == undefined) return; // item was deleted
    items[index].savedText = items[index].text;
    items[index].savedTime = items[index].time;
    items[index].saving = false;
    if (items[index].saveClosure) {
      items[index].saveClosure(index);
      items[index].saveClosure = null;
    }
  }

  let layoutPending = false;
  function onItemResized(itemdiv, trigger: string) {
    const id = itemdiv.id;
    const index = indexFromId.get(id);
    if (index == undefined) return;
    // const height = parseInt(window.getComputedStyle(itemdiv).height);
    // const height = Math.min(itemdiv.clientHeight, itemdiv.offsetHeight);
    // const height = itemdiv.getBoundingClientRect().height;
    const height = itemdiv.offsetHeight;
    const prevHeight = items[index].height;
    if (height == prevHeight) return; // nothing has changed
    // NOTE: on iOS, editing items can trigger zero height to be reported, which we ignore
    //       (seems to make sense generally since items should not have zero height)
    if (height == 0 && prevHeight > 0) {
      // console.warn(
      //   `zero height (last known height ${prevHeight}) for item ${id} at index ${index+1}`,
      //   items[index].text.substring(0, Math.min(items[index].text.length, 80))
      // );
      return;
    }

    const lctext = items[index].text.toLowerCase();
    const tags = itemTags(lctext);
    const label = lctext.startsWith(tags[0]) ? tags[0] : "";
    console.debug(`[${index + 1}] ${label ? label + ": " : ""} height changed ${prevHeight} → ${height} (${trigger})`);
    items[index].height = height;

    // NOTE: Heights can fluctuate due to async scripts that generate div contents (e.g. charts), especially where the height of the output is not known and can not be specified via CSS, e.g. as an inline style on the div. We tolerate these changes for now, but if this becomes problematic we can skip or delay some layout updates, especially when the height is decreasing, postponing layout update to other events, e.g. reordering of items.
    if (height == 0 || prevHeight == 0 || height != prevHeight) {
      if (!layoutPending) {
        layoutPending = true;
        setTimeout(() => {
          updateItemLayout();
          layoutPending = false;
        }, 250);
      }
    }
  }

  function extractBlock(text: string, type: string) {
    // NOTE: this logic is consistent with onInput() in Editor.svelte
    let insideBlock = false;
    let regex = RegExp("^\\s*```" + type + "(\\s|$)");
    return text
      .split("\n")
      .map((line) => {
        if (!insideBlock && line.match(regex)) insideBlock = true;
        else if (insideBlock && line.match(/^\s*```/)) insideBlock = false;
        if (line.match(/^\s*```/)) return "";
        return insideBlock ? line : "";
      })
      .filter((t) => t)
      .join("\n")
      .trim();
  }

  let evalIndex = -1;
  function evalJSInput(text: string, label: string = "", index: number = -1): string {
    let jsin = extractBlock(text, "js_input");
    if (jsin.length == 0) return "";
    if (index >= 0) jsin = jsin.replace(/\$id/g, items[index].id);
    let start = Date.now();
    try {
      evalIndex = index;
      let out = eval("(function(){" + jsin + "})()");
      if (out && out.length > 1024) {
        alert(`js output too large (${out.length})`);
        out = "";
      }
      evalIndex = -1;
      return out;
    } catch (e) {
      evalIndex = -1;
      let msg = e.toString();
      if (label) msg = label + ": " + msg;
      if (console["_eval_error"]) console["_eval_error"](msg);
      else alert(msg);
      // automatically _write_log any errors into item
      if (index >= 0) {
        window["_write_log"](items[index].id, start);
      }
      return undefined;
    }
  }

  function appendBlock(text: string, type: string, block: string) {
    block = "\n```" + type + "\n" + block + "\n```";
    const regex = "\\n\\s*```" + type + "\\n.*?\\n\\s*```";
    if (text.match(RegExp(regex, "s"))) {
      text = text.replace(RegExp(regex, "gs"), block);
    } else {
      text += block;
    }
    return text;
  }

  function appendJSOutput(text: string, index: number = -1): string {
    if (!text.match(/\s*```js_input\s/)) return text; // no js code in text
    // execute JS code, including any tag-referenced items (using latest tags/label)
    const lctext = text.toLowerCase();
    const tags = itemTags(lctext);
    const label = lctext.startsWith(tags[0]) ? tags[0] : "";
    let jsout = [];
    tags.forEach((tag) => {
      if (tag == label) return;
      const indices = indicesFromLabel.get(tag) || [];
      indices.forEach((index) => {
        jsout.push(evalJSInput(items[index].text, items[index].label, index) || "");
      });
    });
    jsout.push(evalJSInput(text, label, index) || "");
    let jsoutString = jsout.join("\n").trim();
    if (!jsoutString) return text; // no output
    return appendBlock(text, "js_output", jsoutString);
  }

  function saveItem(index: number) {
    let item = items[index];
    // save new text
    item.saving = true;
    const itemToSave = { time: item.time, text: item.text };
    firestore()
      .collection("items")
      .doc(item.id)
      .update(itemToSave)
      .then(() => {
        onItemSaved(item.id);
      })
      .catch(console.error);
    // also save to items-history ...
    firestore()
      .collection("items-history")
      .add({ item: item.id, ...itemToSave })
      .catch(console.error);
  }

  // https://stackoverflow.com/a/9039885
  function iOS() {
    return (
      ["iPad Simulator", "iPhone Simulator", "iPod Simulator", "iPad", "iPhone", "iPod"].includes(navigator.platform) ||
      // iPad on iOS 13 detection
      (navigator.userAgent.includes("Mac") && "ontouchend" in document)
    );
  }

  function onItemEditing(index: number, editing: boolean, cancelled: boolean) {
    let item = items[index];

    // if cancelled, restore savedTime and savedText (unless empty, which indicates deletion)
    if (cancelled) {
      item.time = item.savedTime;
      if (item.text) item.text = item.savedText;
    } else {
      // for non-log items, update time whenever the item is "touched"
      if (!item.text.match(/(?:^|\s)#log(?:\s|$)/)) item.time = Date.now();
    }

    if (editing) {
      // started editing
      editingItems.push(index);
      if (item.time != item.savedTime) onEditorChange(editorText); // time has changed
      // NOTE: setTimeout is required for editor to be added to the Dom
      if (iOS()) {
        textArea(-1).focus(); // temporary, allows focus to be set ("shifted") within setTimout, outside click event
        // See https://stackoverflow.com/questions/12204571/mobile-safari-javascript-focus-method-on-inputfield-only-works-with-click.
      }
      setTimeout(() => {
        textArea(item.index).focus();
        // if (item.index < index) window.top.scrollTo(0, 0); // scroll to top if item was moved up
      }, 0); // trigger resort
    } else {
      // stopped editing
      editingItems.splice(editingItems.indexOf(index), 1);
      if (focusedItem == index) focusedItem = -1;
      if (item.text.length == 0) {
        // delete
        items.splice(index, 1);
        updateItemLayout();
        items = items; // trigger dom update
        deletedItems.unshift({
          time: item.savedTime,
          text: item.savedText,
        }); // for /undelete
        firestore().collection("items").doc(item.id).delete().catch(console.error);
      } else {
        // clear _output and execute javascript unless cancelled
        if (!cancelled) {
          // empty out any *_output|*_log blocks as they should be re-generated
          item.text = item.text.replace(/\n\s*```(\w*?_output)\n.*?\n\s*```/gs, "\n```$1\n\n```");
          item.text = item.text.replace(/\n\s*```(\w*?_log)\n.*?\n\s*```/gs, "\n```$1\nrunning ...\n```");
          // NOTE: these appends may trigger async _write
          item.text = appendJSOutput(item.text, index);
        }
        if (item.time != item.savedTime || item.text != item.savedText) saveItem(index);
        onEditorChange(editorText); // item time and/or text has changed
      }

      // NOTE: we do not focus back up on the editor on the iPhone as it can cause a disorienting jump
      //       that is not worth the benefit without an attached keyboard (which is harder to detect)
      //       (actually we no longer do that on non-iphone either)
      if (editingItems.length > 0) {
        // || !navigator.platform.startsWith("iPhone")) {
        focusOnNearestEditingItem(index);
      } else {
        (document.activeElement as HTMLElement).blur();
      }
    }
    // console.log(`item ${index} editing: ${editing}, editingItems:${editingItems}, focusedItem:${focusedItem}`);
  }

  function onItemFocused(index: number, focused: boolean) {
    if (focused) focusedItem = index;
    else focusedItem = -1;
    // console.log(`item ${index} focused: ${focused}, focusedItem:${focusedItem}`);
  }

  function onItemRun(index: number) {
    // empty out any *_output|*_log blocks as they should be re-generated
    items[index].text = items[index].text.replace(/\n\s*```(\w*?_output)\n.*?\n\s*```/gs, "\n```$1\n\n```");
    items[index].text = items[index].text.replace(/\n\s*```(\w*?_log)\n.*?\n\s*```/gs, "\n```$1\nrunning ...\n```");
    items[index].text = appendJSOutput(items[index].text, index);
    items[index].time = Date.now();
    onEditorChange(editorText); // item time/text has changed
    saveItem(index);
  }

  function editItem(index: number) {
    items[index].editing = true;
    editingItems.push(index);
  }

  function textArea(index: number): HTMLTextAreaElement {
    return document.getElementById("textarea-" + (index < 0 ? "editor" : items[index].id)) as HTMLTextAreaElement;
  }

  function onPrevItem(inc = -1) {
    if (focusedItem + inc < -1) return;
    const index = focusedItem;
    const textarea = textArea(index);
    if (index + inc == -1) textArea(-1).focus();
    else {
      if (!items[index + inc].editing) {
        if (items[index + inc].pinned) {
          onPrevItem(inc - 1);
          return;
        } // skip if pinned
        editItem(index + inc);
      }
      setTimeout(() => textArea(index + inc).focus(), 0);
    }
  }

  function onNextItem(inc = 1) {
    if (focusedItem + inc >= items.length) return;
    const index = focusedItem;
    const textarea = textArea(index);
    if (!items[index + inc].editing) {
      if (items[index + inc].pinned) {
        onNextItem(inc + 1);
        return;
      } // skip if pinned
      editItem(index + inc);
    }
    setTimeout(() => textArea(index + inc).focus(), 0);
  }

  function updateDotted() {
    // auto-hide dotted items (and console) when empty
    if (dotCount == 0 && consolediv.childNodes.length == 0) showDotted = false;
    // force show dotted items when any of them are editing
    if (editingItems.findIndex((i) => items[i].dotted) >= 0) showDotted = true;
    (document.querySelector("span.dots") as HTMLElement).style.opacity = "1";
    (document.querySelector("span.dots") as HTMLElement).style.visibility = showDotted ? "hidden" : "visible";
    document.getElementById("console-summary").style.visibility = showDotted ? "hidden" : "visible";
    Array.from(document.querySelectorAll(".dotted")).forEach((dotted) => {
      (dotted as HTMLElement).style.display = showDotted ? "block" : "none";
    });
    consolediv.style.display = showDotted && consolediv.childNodes.length > 0 ? "block" : "none";
  }

  let lastScrollTime = 0;
  let lastScrolledDownTime = 0;
  let scrollToggleLocked = false; // prevent repeated toggle
  let showDotted = false;
  let showDottedPending = false;
  function onScroll() {
    lastScrollTime = Date.now();
    if (window.scrollY > 0) lastScrolledDownTime = lastScrollTime;
    if (window.scrollY == 0) lastScrolledDownTime = 0;
    if (window.scrollY <= -100 && !scrollToggleLocked && Date.now() - lastScrolledDownTime > 1000) {
      scrollToggleLocked = true;
      showDotted = !showDotted;
      // NOTE: display:none on any elements (even spans) while bouncing breaks the bounce animation on iOS
      // (playing around with visibility/height/position/etc did not work either)
      showDottedPending = true;
      (document.querySelector("span.dots") as HTMLElement).style.visibility = "visible";
      (document.querySelector("span.dots") as HTMLElement).style.opacity = "0.5";
    } else if (window.scrollY >= -25) {
      scrollToggleLocked = false;
      if (window.scrollY >= 0) {
        if (showDottedPending) {
          updateDotted();
          showDottedPending = false;
        }
      }
    }
  }

  function onStatusClick(e) {
    // ignore click if text is selected
    if (window.getSelection().type == "Range") {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    showDotted = !showDotted;
    updateDotted();
  }

  import { onMount } from "svelte";

  if (isClient) {
    // initialize indices and savedText/Time
    onEditorChange(""); // initial sort, index assignment, etc
    items.forEach((item) => {
      item.savedText = item.text;
      item.savedTime = item.time;
    });

    // Sign in user as needed ...
    if (error) console.log(error); // log server-side error
    // NOTE: test server-side error with document.cookie='__session=signed_out;max-age=0';
    firebase()
      .auth()
      .onAuthStateChanged((authUser) => {
        if (authUser) {
          // user logged in
          user = authUser;
          loggedIn = true;

          // copy console into #console if it exists
          if (consolediv) {
            // NOTE: some errors do not go through console.error but are reported via window.onerror
            console["_window_error"] = () => {}; // no-op, used to redirect window.onerror
            console["_eval_error"] = () => {}; // no-op, used to redirect error during evalJSInput()
            const levels = ["debug", "info", "log", "warn", "error", "_window_error", "_eval_error"];
            levels.forEach(function (verb) {
              console[verb] = (function (method, verb, div) {
                return function (...args) {
                  method(...args);
                  var elem = document.createElement("div");
                  if (verb.endsWith("error")) verb = "error";
                  elem.classList.add("console-" + verb);
                  let item; // if the source is an item (and the logging is done _synchronously_)
                  if (window["_script_item_id"] && indexFromId.has(window["_script_item_id"])) {
                    item = items[indexFromId.get(window["_script_item_id"])];
                  } else if (evalIndex) {
                    item = items[evalIndex];
                  }
                  if (item) {
                    // prepent item index, label (if any)
                    // NOTE: item.label can be outdated at this point due to pending save
                    const lctext = item.text.toLowerCase();
                    const tags = itemTags(lctext);
                    const label = lctext.startsWith(tags[0]) ? tags[0] : "";
                    if (label) args.unshift(label + ":");
                    args.unshift(`[${item.index + 1}]`);
                  }
                  elem.textContent = args.join(" ") + "\n";
                  elem.setAttribute("_time", Date.now().toString());
                  elem.setAttribute("_level", levels.indexOf(verb).toString());
                  div.appendChild(elem);
                  div.style.opacity = "1";
                  const summaryDiv = document.getElementById("console-summary");
                  const summaryElem = document.createElement("span");
                  summaryElem.innerText = "·";
                  summaryElem.classList.add("console-" + verb);
                  summaryDiv.appendChild(summaryElem);

                  // auto-remove after 10 seconds ...
                  setTimeout(() => {
                    elem.remove();
                    summaryElem.remove();
                    if (div.childNodes.length == 0) div.style.opacity = "0";
                  }, 10000);
                };
              })(console[verb].bind(console), verb, consolediv);
            });
          }

          console.log("signed in", user.email);
          localStorage.setItem("user", JSON.stringify(user));

          // proceeed to set up server-side session cookie only if user is allowed
          if (allowedUsers.includes(user.uid)) {
            // Store user's ID token as a 1-hour __session cookie to send to server for preload
            // NOTE: __session is the only cookie allowed by firebase for efficient caching
            //       (see https://stackoverflow.com/a/44935288)
            user
              .getIdToken(false /*force refresh*/)
              .then((token) => {
                document.cookie = "__session=" + token + ";max-age=86400";
                console.log("updated cookie", error || "(no error)");
                // reload with new cookie if we are on error page
                if (error) location.reload();
              })
              .catch(console.error);
          }
        } else {
          // return // test signed out state
          let provider = new window.firebase.auth.GoogleAuthProvider();
          firebase().auth().useDeviceLanguage();
          // firebase().auth().setPersistence("none")
          // firebase().auth().setPersistence("session")
          firebase().auth().setPersistence("local");
          firebase().auth().signInWithRedirect(provider);
          firebase()
            .auth()
            .getRedirectResult()
            .then((result) => {
              user = result.user;
              console.log("signed in after redirect", error || "no error");
              // reload if we are on an error page
              // NOTE: this can lead to infinite loop if done without some delay
              // if (error) location.reload()
              // setTimeout(()=>{if (error) location.reload()}, 1000)
            })
            .catch(console.error);
        }
      });

    // Set up global helper functions for javascript:... shortcuts
    window["_replace"] = function (text: string) {
      onEditorChange((editorText = text));
    };
    window["_replace_edit"] = function (text: string) {
      onEditorChange((editorText = (text + " ").trimStart()));
      textArea(-1).focus();
    };
    window["_append"] = function (text: string) {
      onEditorChange((editorText = (editorText.trim() + " " + text).trimStart()));
    };
    window["_append_edit"] = function (text: string) {
      onEditorChange((editorText = (editorText.trim() + " " + text).trim() + " "));
      textArea(-1).focus();
    };
    window["_enter"] = function (text: string) {
      onEditorDone(text || editorText);
    };
    window["_text"] = function () {
      return editorText.trim();
    };
    window["_append_clipboard"] = function () {
      navigator.clipboard.readText().then(window["_append"]).catch(alert);
    };
    window["_append_clipboard_link"] = function (
      prefix: string,
      title: string,
      suffix: string,
      enter: boolean = false
    ) {
      navigator.clipboard
        .readText()
        .then((urlstr) => {
          try {
            let url = new URL(urlstr);
            window["_append_edit"](`${prefix}[${title || url.host}](${urlstr})${suffix}`);
            if (enter) window["_enter"]();
          } catch (_) {
            alert("clipboard content is not a URL");
          }
        })
        .catch(alert);
    };
    window["_encoded_text"] = function () {
      return encodeURIComponent(editorText.trim());
    };
    window["_google"] = function () {
      let query = editorText.replace(/^\/\s+/s, "").trim();
      onEditorChange((editorText = ""));
      window.open("https://google.com/search?q=" + encodeURIComponent(query));
    };
    window["_tweet"] = function () {
      let tweet = editorText.replace(/^\/\s+/s, "").trim();
      onEditorChange((editorText = ""));
      if (tweet == "") {
        onEditorDone("/tweet", null);
      } else {
        location.href = "twitter://post?message=" + encodeURIComponent(tweet);
      }
    };
    window["_eval"] = function (tag: string) {
      const indices = indicesFromLabel.get(tag) || [];
      const jsout = indices.map((index) => evalJSInput(items[index].text, items[index].label));
      return jsout.length == 1 ? jsout[0] : jsout;
    };

    function indicesForItem(item: string) {
      if (item == "" && evalIndex >= 0) {
        return [evalIndex];
      } else if (item == "" && window["_script_item_id"] && indexFromId.has(window["_script_item_id"])) {
        return [indexFromId.get(window["_script_item_id"])];
      } else if (indexFromId.has(item)) {
        return [indexFromId.get(item)];
      } else {
        return indicesFromLabel.get(item) || [];
      }
    }

    window["_id"] = function (item: string = "") {
      let ids = [];
      let indices = indicesForItem(item);
      indices.map((index) => {
        ids.push(items[index].id);
      });
      return ids.length == 1 ? ids[0] : ids;
    };

    window["_read"] = function (type: string = "", item: string = "", include_tagrefs: boolean = false) {
      let content = [];
      let indices = indicesForItem(item);
      indices.map((index) => {
        if (include_tagrefs) {
          const lctext = items[index].text.toLowerCase();
          const tags = itemTags(lctext);
          const label = lctext.startsWith(tags[0]) ? tags[0] : "";
          tags.filter((t) => t != label).forEach((tag) => content.push(window["_read"](type, tag, include_tagrefs)));
        }
        if (type == "") content.push(items[index].text);
        else content.push(extractBlock(items[index].text, type));
      });
      return content.join("\n");
    };

    let _writePendingItem = "";
    let _writePendingItemLog = "";
    window["_write"] = function (item: string, text: string, type: string = "_output") {
      // if writing _log to item pending another _write, attach to that write
      if (type == "_log" && item == _writePendingItem) {
        _writePendingItemLog = text;
        return;
      }
      // NOTE: write is always async in case triggered by eval during onItemEditing
      _writePendingItem = item;
      setTimeout(() => {
        let log = "";
        if (_writePendingItem == item) {
          log = _writePendingItemLog;
          _writePendingItemLog = _writePendingItem = "";
        }
        let indices = indicesForItem(item);
        // console.log("_write", indices, item);
        indices.map((index) => {
          if (items[index].editing) {
            console.log("can not _write to item while editing");
            return;
          }
          const prevSaveClosure = items[index].saveClosure;
          const saveClosure = (index) => {
            if (text && text.length > 1024) {
              alert(`_write too large (${text.length})`);
              text = "";
            }
            if (type == "") items[index].text = text;
            else items[index].text = appendBlock(items[index].text, type, text);
            if (log) items[index].text = appendBlock(items[index].text, "_log", log);
            if (prevSaveClosure) prevSaveClosure(index); // chain closures
            items[index].time = Date.now();
            onEditorChange(editorText); // item time/text has changed
            // NOTE: if write block type ends with _tmp, then we do NOT save changes to item
            if (!type.endsWith("_tmp")) saveItem(index);
          };
          if (items[index].saving) {
            items[index].saveClosure = saveClosure;
            // console.log("_write is postponed until saving is complete");
          } else {
            saveClosure(index); // write and save immediately
          }
        });
      }, 0);
    };

    window["_write_log"] = function (item: string, since: number = 0, level: number = 0) {
      let log = [];
      consolediv.childNodes.forEach((elem) => {
        if (elem.getAttribute("_time") < since) return;
        if (elem.getAttribute("_level") < level) return;
        const type = elem.className.substring(elem.className.indexOf("-") + 1);
        let prefix = type == "log" ? "" : type.toUpperCase() + ": ";
        if (prefix == "WARN: ") prefix = "WARNING: ";
        log.push(prefix + elem.innerText.trim());
      });
      window["_write"](item, log.join("\n"), "_log");
    };

    window["_task"] = function (interval: number, task: Function, item: string = "") {
      let indices = indicesForItem(item);
      if (!window["_tasks"]) window["_tasks"] = {};
      indices.map((index) => {
        // clear any previous tasks for item, under id or tmpid
        clearInterval(window["_tasks"][items[index].id]);
        clearInterval(window["_tasks"][items[index].tmpid]);
        delete window["_tasks"][items[index].id];
        delete window["_tasks"][items[index].tmpid];
        window["_tasks"][items[index].id] = setInterval(task, interval);
        task(); //  also execute immediately
      });
    };

    // recursive version of Object.assign that does a deep merge
    function recursiveAssign(a, b) {
      if (a == undefined || typeof b !== "object") return b;
      if (typeof a !== "object") a = {};
      for (let key in b) a[key] = recursiveAssign(a[key], b[key]);
      return a;
    }

    // wrapper for c3.generate that stores a reference (_chart) on the DOM element
    // (allows us to get a list of all charts and e.g. trigger resize on font resize (see onMount below))
    // also sets some default options and classes (e.g. c3-labeled and c3-rotated) for custom styling
    // also ensures element style.height matches size.height if specified (otherwise sizing is lost on window resize)
    window["_chart"] = function (selector: string, spec: object) {
      let rotated = spec["axis"] && spec["axis"]["rotated"];
      let labeled = spec["data"] && spec["data"]["labels"];
      let barchart = spec["data"] && spec["data"]["type"] == "bar";
      let defaults = {
        bindto: selector,
        point: { r: 5 },
        padding: { top: 10, right: 5 },
        axis: {
          x: {
            show: true,
            tick: { outer: false },
            padding: 0,
          },
          y: {
            show: !labeled,
            tick: { outer: false, multiline: false },
            padding: { bottom: 5, top: rotated && labeled ? 70 : labeled ? 40 : 5 },
          },
        },
        grid: { focus: { show: !barchart } },
      };
      if (labeled) {
        if (rotated) defaults.padding["bottom"] = 15;
        else defaults.padding["left"] = 5;
      }
      spec = recursiveAssign(defaults, spec);
      Array.from(document.querySelectorAll(selector)).forEach((elem) => {
        if (labeled) elem.classList.add("c3-labeled");
        if (rotated) elem.classList.add("c3-rotated");
        if (barchart) elem.classList.add("c3-barchart");
      });
      const chart = window["c3"].generate(spec);
      Array.from(document.querySelectorAll(selector)).forEach((elem) => {
        if (spec["size"] && spec["size"]["height"]) (elem as HTMLElement).style.height = spec["size"]["height"] + "px";
        elem["_chart"] = chart;
      });
      return chart;
    };

    // wrapper for d3 graphviz
    window["_dot"] = function (selector: string, dot: string) {
      // NOTE: best way to define defaults seems to be by inserting attributes into the dot, which are turned into SVG attributes by d3 graphviz, which take lowest priority (as opposed to inline styles which would take highest, see https://stackoverflow.com/a/24294284) and can be easily modified either in the dot code or using CSS
      const nodedefs =
        'color="#999999",fontcolor="#999999",fontname="Avenir Next, Helvetica",fontsize=20,shape=circle,fixedsize=true';
      const edgedefs = 'color="#999999",fontcolor="#999999",fontname="Avenir Next, Helvetica",penwidth=1';
      const graphdefs = `bgcolor=invis; color="#666666"; fontcolor="#666666"; fontname="Avenir Next, Helvetica"; fontsize=20; nodesep=.2; ranksep=.3; node[${nodedefs}]; edge[${edgedefs}]`;
      const subgraphdefs = `labeljust="r"; labelloc="b"; edge[minlen=2]`;
      dot = dot.replace(/(subgraph.*?{)/g, `$1\n${subgraphdefs};\n`);
      dot = dot.replace(/(graph.*?{)/g, `$1\n${graphdefs};\n`);
      window["d3"]
        .select(selector)
        .graphviz()
        .zoom(false)
        .renderDot(dot, function () {
          const elem = document.querySelector(selector);
          // NOTE: _dotrendered is defined automatically in Item.svelte
          if (elem && elem["_dotrendered"]) elem["_dotrendered"]();
        });
    };

    window["_histogram"] = function (
      numbers: any,
      bins: number = 10,
      min: number = Infinity,
      max: number = -Infinity,
      digits: number = 2
    ) {
      // if numbers is a distribution, attempt to extract values using window._samples
      if (numbers["getDist"]) numbers = window["_samples"](numbers);
      if (min > max) {
        // determine range using data
        numbers.forEach((num) => {
          if (num < min) min = num;
          else if (num > max) max = num;
        });
      } else {
        numbers = numbers.filter((num) => num >= min && num <= max);
      }
      const size = (max - min) / bins;
      const counts = new Array(bins).fill(0);
      numbers.forEach((num) => {
        counts[num == max ? bins - 1 : Math.floor((num - min) / size)]++;
      });
      let histogram = {};
      counts.forEach((count, index) => {
        let key = `[${(min + index * size).toFixed(digits)}, `;
        key += index == bins - 1 ? `${max.toFixed(digits)}]` : `${(min + (index + 1) * size).toFixed(digits)})`;
        histogram[key] = count > 0 ? count : null; // replace 0 -> null
      });
      return histogram;
    };

    window["_counts"] = function (list, limit: number = 10) {
      let counts = {};
      list.forEach((x) => {
        x = JSON.stringify(x);
        counts[x] = (counts[x] || 0) + 1;
      });
      let keys = Object.keys(counts);
      let values = Object.values(counts) as Array<number>;
      let indices = Array.from(Array(values.length).keys());
      indices = stableSort(indices, (i, j) => values[j] - values[i]);
      indices = indices.filter((i) => values[i] > 0);
      indices.length = Math.min(indices.length, limit);
      counts = {};
      indices.forEach((i) => (counts[keys[i]] = values[i]));
      return counts;
    };

    window["_pmf"] = function (dist, limit: number = 10, digits: number = 2) {
      dist = dist.getDist();
      let keys = Object.keys(dist).map((k) => k.toString());
      let probs = Object.values(dist).map((v) => v["prob"]);
      let indices = Array.from(Array(probs.length).keys());
      indices = stableSort(indices, (i, j) => probs[j] - probs[i]);
      probs = probs.map((v) => v.toFixed(digits));
      indices = indices.filter((i) => probs[i] > 0);
      indices.length = Math.min(indices.length, limit);
      let pmf = {};
      indices.forEach((i) => (pmf[keys[i]] = probs[i]));
      return pmf;
    };

    window["_samples"] = function (dist) {
      dist = dist.getDist();
      let values = Object.keys(dist).map(parseFloat);
      let probs = Object.values(dist).map((v) => v["prob"]);
      if (Math.min(...probs) != Math.max(...probs)) console.warn("sample weights ignored by _samples (or _histogram)");
      return values;
    };

    // Visual viewport resize/scroll handlers ...
    // NOTE: we use document width because it is invariant to zoom scale
    //       window.outerWidth is also invariant but can be stale after device rotation in iOS Safari
    // NOTE: font resizing does not trigger resize events and is handled in a periodic task, see onMount below
    let lastDocumentWidth = 0;
    let resizePending = false;
    function tryResize() {
      if (Date.now() - lastScrollTime > 250) {
        const documentWidth = document.documentElement.clientWidth;
        if (documentWidth != lastDocumentWidth) {
          console.log(`document width changed from ${lastDocumentWidth} to ${documentWidth}`);
          updateItemLayout();
          // also trigger resize of all charts on the page ...
          Array.from(document.querySelectorAll(".c3")).map((div) => {
            if (div["_chart"]) div["_chart"].resize();
          });
          lastDocumentWidth = documentWidth;
        }
      } else if (!resizePending) {
        resizePending = true;
        setTimeout(() => {
          resizePending = false;
          tryResize();
        }, 250);
      }
    }
    visualViewport.addEventListener("resize", tryResize);
    visualViewport.addEventListener("scroll", onScroll);

    onMount(() => {
      // NOTE: invoking onEditorChange on a timeout allows item heights to be available for initial layout
      setTimeout(() => onEditorChange(""), 0);
      setInterval(tryResize, 250); // no need to destroy since page-level
      updateDotted();
    });

    // Restore user from localStorage for faster init
    // NOTE: Making the user immediately available creates two problems: (1) user.photoURL returns 403 (even though URL is the same and even if user object is maintained in onAuthStateChanged), (2) initial editor focus fails mysteriously. Both problems are fixed if we condition these elements on a loggedIn flag set to true in onAuthStateChanged call from firebase auth.
    if (!user && localStorage.getItem("user")) {
      user = JSON.parse(localStorage.getItem("user"));
      console.log("restored user from local storage");
    }
    console.log("first script run, items:", items.length);
  }

  // disable editor shortcuts
  function onKeyPress(e: KeyboardEvent) {
    // disable save/forward/back shortcuts on window, focus on editor instead
    if (focusedItem >= 0) return; // already focused on an item
    if (
      (e.code == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) ||
      (e.code == "KeyS" && (e.metaKey || e.ctrlKey)) ||
      ((e.code == "BracketLeft" || e.code == "BracketRight") && (e.metaKey || e.ctrlKey)) ||
      (e.code == "Slash" && (e.metaKey || e.ctrlKey)) ||
      e.code == "Tab"
    ) {
      e.preventDefault();
      textArea(-1).focus();
      window.top.scrollTo(0, 0);
    }
  }

  // redirect error to alert or console._window_error if it exists
  function onError(e) {
    const msg = `${e.message} (lineno:${e.lineno}, colno:${e.colno})`;
    if (console["_window_error"]) console["_window_error"](msg);
    else alert(msg);
    if (!window["_errors"]) window["_errors"] = [];
    window["_errors"].push(e);
  }
</script>

<style>
  #loading {
    display: flex;
    min-height: 100vh;
    min-height: -webkit-fill-available; /*consider bottom bar on iOS Safari*/
    justify-content: center;
    align-items: center;
    background: #111 url(/loading.gif) no-repeat center;
    background-size: 200px;
  }
  #header {
    width: 100%;
  }
  #header-container {
    display: flex;
    padding: 4px 0;
    border-left: 2px solid #444;
    background: #111; /* matches unfocused editor */
  }
  #header-container.focused {
    background: #111;
    border-left: 2px solid #aaa;
  }
  #editor {
    margin-right: 4px;
    width: 100%;
  }
  /* remove dashed border when top editor is unfocused */
  :global(#header #editor .backdrop:not(.focused)) {
    border: 1px solid transparent;
  }
  .spacer {
    flex-grow: 1;
  }
  #user {
    height: 45px; /* must match height of single-line editor (also see @media query below) */
    margin-right: 4px;
    border-radius: 50%;
    background: gray;
    cursor: pointer;
  }
  #console {
    /* position: absolute; */
    /* top: 0; */
    /* right: 0; */
    /* z-index: 10; */
    color: #999;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 0 0 0 4px;
    font-family: monospace;
    padding-top: 4px; /* for 8px total padding between header and first item */
    pointer-events: none;
    text-align: left;
    -webkit-touch-callout: auto;
    -webkit-user-select: auto;
    user-select: auto;
  }
  :global(.console-debug) {
    color: #555;
  }
  :global(.console-info) {
    color: #777;
  }
  :global(.console-log) {
    color: #999;
  }
  :global(.console-warn) {
    color: yellow;
  }
  :global(.console-error) {
    color: red;
  }
  #status {
    padding: 4px;
    padding-right: 8px;
    text-align: center;
    font-family: monospace;
    font-size: 12px;
    color: #999;
    cursor: pointer;
    position: relative;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  #status #console-summary {
    position: absolute;
    left: 0;
    padding-left: 4px;
  }
  #status .counts {
    position: absolute;
    right: 0;
    top: 0;
    padding-right: 11px; /* matches .corner inset on first item */
    padding-top: 4px;
  }
  #status .matching {
    color: #9f9;
  }

  .items {
    width: 100%;
    display: flex;
  }
  .column {
    flex: 1;
    /* NOTE: BOTH min/max width are necessary to get proper flexing behavior */
    min-width: 0px;
    max-width: 750px;
  }
  .section-separator {
    height: 33px; /* 4 full dashes on left border, 40px offsetHeigt is assumed during layout */
    margin-top: 2px;
    margin-bottom: 5px;
    padding-top: 7px;
    padding-left: 8px;
    padding-right: 8px; /* matches padding-right of .super-container from Item.svelte */
    /* border-left: 2px dashed #333; */
    color: #333;
    font-size: 16px;
    font-family: Avenir Next, Helvetica;
    text-align: center;
  }

  .section-separator .arrows {
    font-family: monospace;
    font-size: 20px;
  }

  /* override italic comment style of sunburst */
  :global(.hljs-comment) {
    font-style: normal;
    color: #666;
  }
  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    #user {
      height: 42px; /* must match height of single-line editor (on narrow window) */
    }
  }
</style>

{#if user && allowedUsers.includes(user.uid) && !error}
  <!-- all good! user logged in, has permissions, and no error from server -->

  <div class="items">
    {#each { length: columnCount } as _, column}
      <div class="column">
        {#if column == 0}
          <div id="header" bind:this={headerdiv} on:click={() => textArea(-1).focus()}>
            <div id="header-container" class:focused>
              <div id="editor">
                <Editor
                  bind:text={editorText}
                  bind:focused
                  onFocused={onEditorFocused}
                  onChange={onEditorChange}
                  onDone={onEditorDone}
                  onPrev={onPrevItem}
                  onNext={onNextItem} />
              </div>
              <div class="spacer" />
              {#if loggedIn}<img id="user" src={user.photoURL} alt={user.email} on:click={signOut} />{/if}
            </div>
            <div id="status" on:click={onStatusClick}>
              <span id="console-summary" />&nbsp;<span class="dots">
                {#each { length: dotCount } as _}•{/each}
              </span>
              <div class="counts">
                {items.length}
                {#if matchingItemCount > 0}<span class="matching">{matchingItemCount}</span>{/if}
              </div>
              <div id="console" bind:this={consolediv} />
            </div>
          </div>
          <!-- auto-focus on the editor unless on iPhone -->
          {#if loggedIn}
            <script>
              // NOTE: we do not focus on the editor on the iPhone, which generally does not allow
              //       autofocus except in certain unexpected situations (like coming back to app)
              if (!navigator.platform.startsWith("iPhone")) document.getElementById("textarea-editor").focus();
            </script>
          {/if}
        {/if}

        {#each items as item (item.id)}
          {#if item.column == column}
            <Item
              onEditing={onItemEditing}
              onFocused={onItemFocused}
              onRun={onItemRun}
              onResized={onItemResized}
              {onTagClick}
              onPrev={onPrevItem}
              onNext={onNextItem}
              bind:text={item.text}
              bind:editing={item.editing}
              bind:focused={item.focused}
              bind:saving={item.saving}
              bind:height={item.height}
              bind:time={item.time}
              id={item.id}
              tmpid={item.tmpid}
              index={item.index}
              matchingTerms={item.matchingTerms.join(' ')}
              matchingTermsSecondary={item.matchingTermsSecondary.join(' ')}
              timeString={item.timeString}
              timeOutOfOrder={item.timeOutOfOrder}
              updateTime={item.updateTime}
              createTime={item.createTime}
              dotted={item.dotted}
              runnable={item.runnable} />
            {#if item.nextColumn >= 0}
              <div class="section-separator">
                {item.index + 2}
                <span class="arrows">
                  {#if item.nextColumn < item.column}
                    ↖{#each { length: item.column - item.nextColumn - 1 } as _}←{/each}
                  {:else}
                    {#each { length: item.nextColumn - item.column - 1 } as _}→{/each}↗
                  {/if}
                </span>
                {#if item.nextItemInColumn >= 0}{item.nextItemInColumn + 1}<span class="arrows">↓</span>{/if}
              </div>
            {/if}
          {/if}
        {/each}
      </div>
    {/each}
  </div>
{:else if user && !allowedUsers.includes(user.uid)}
  <!-- user logged in but not allowed -->
  Hello
  {user.email}!
{:else if error}
  <!-- user logged in, has permissions, but server returned error -->
  <div id="loading" />
{:else if !user && !error}
  <!-- user not logged in and no errors from server yet (login in progress) -->
  <script>
    console.log("loading ...");
  </script>
  <div id="loading" />
{:else}
  <!-- should not happen -->
  ?
{/if}

<svelte:window on:keypress={onKeyPress} on:error={onError} on:scroll={onScroll} />
