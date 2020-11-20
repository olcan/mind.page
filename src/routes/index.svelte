<script context="module" lang="ts">
  import {
    isClient,
    firebase,
    firestore,
    firebaseConfig,
    firebaseAdmin,
  } from "../../firebase.js";
  const allowedUsers = ["y2swh7JY2ScO5soV7mJMHVltAOX2"]; // user.uid for olcans@gmail.com

  // NOTE: Preload function can be called on either client or server
  // See https://sapper.svelte.dev/docs#Preloading
  export async function preload(page, session) {
    // console.log("preloading, client?", isClient);
    // NOTE: for development server, admin credentials require `gcloud auth application-default login`
    const user: any = await firebaseAdmin()
      .auth()
      .verifyIdToken(session.cookie)
      .catch(console.error);
    if (user && allowedUsers.includes(user.uid)) {
      let items = await firebaseAdmin()
        .firestore()
        .collection("items")
        .orderBy("time", "desc")
        .get();
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
  let pages = [];
  let pageHeights = [];
  let maxSectionHeight = 0;
  function updateItemIndices() {
    editingItems = [];
    focusedItem = -1;
    let prevTime = Infinity;
    let prevTimeString = "";
    indexFromId = new Map();
    indicesFromLabel = new Map();
    let sectionHeight = 0;
    let columnCount = 1;
    let sectionIndex = 0;
    let pageIndex = 0;
    let pageHeight = 0;
    let timeString = "";
    pages = [0];
    pageHeights = []; // needs a final append for last page
    // NOTE: once header is available, we can calculate # columns and maxSectionHeight
    if (document.getElementById("header")) {
      // NOTE: we use outerWidth as it is not subject to zooming/scaling
      columnCount = Math.round(
        outerWidth / document.getElementById("header").offsetWidth
      );
      // NOTE: on iOS both visualViewport.height and window.innerHeight account for top bar but only visualViewport accounts for the keyboard overlay. Both are subject to zooming (scale>1) while window.outerHeight is not.
      maxSectionHeight = outerHeight;
      sectionHeight = document.getElementById("header").offsetHeight; // first page includes header
    }
    items.forEach((item, index) => {
      item.index = index;
      item.page = pageIndex;
      indexFromId.set(item.id, index);
      if (item.label) {
        indicesFromLabel.set(item.label, [
          ...(indicesFromLabel.get(item.label) || []),
          index,
        ]);
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
        item.timeString =
          timeString == prevTimeString && !item.timeOutOfOrder
            ? ""
            : timeString;
        // item.timeString = Math.floor((Date.now() - item.time)/1000).toString()
        prevTimeString = timeString;
        prevTime = item.time;
      }
      item.sectionStart = false;
      if (maxSectionHeight > 0) {
        // page based on item heights (plus super-container padding/margin and timeString height)
        let sectionHeightPreItem = sectionHeight;
        pageHeight = Math.max(pageHeight, sectionHeightPreItem);
        sectionHeight += item.height + 8 + (item.timeString ? 24 : 0); // include margins and timeString
        // NOTE: if paging at this item cuts page height by more than half, then we page on next item
        item.sectionStart =
          columnCount > 1 &&
          sectionHeight > maxSectionHeight &&
          sectionHeightPreItem >= maxSectionHeight / 2;
        if (item.sectionStart) {
          sectionHeight = item.height + 8 + (item.timeString ? 24 : 0);
          // console.log(
          //   `cutting off section ${sectionIndex} at index ${index}, height ${sectionHeightPreItem} (max ${maxSectionHeight}), new section at height ${sectionHeight}`
          // );
        }
      } else {
        item.sectionStart = index > 0 && index % 5 == 0; // 5 items per section
      }
      item.pageStart = false;
      if (item.sectionStart) {
        sectionIndex++;
        item.pageStart = columnCount > 1 && sectionIndex % columnCount == 0;
      }
      if (item.pageStart) {
        pageHeights.push(pageHeight);
        pageHeight = sectionHeight;
        pageIndex++;
        item.page++;
        item.timeString = timeString; // always include time string for new page
        pages.push(item.page);
      }
    });
    pageHeights.push(pageHeight); // last page height
    // console.log(pageHeights);

    if (focusedItem >= 0) {
      // maintain focus on item
      const textarea = textArea(focusedItem);
      if (textarea) setTimeout(() => textarea.focus(), 0); // allow dom update before refocus
    } else {
      // refocus on editor if it was unfocused within last .25 seconds
      if (Date.now() - editorBlurTime < 250) textArea(-1).focus();
    }
  }

  // initialize indices and savedText/Time
  if (isClient) {
    onEditorChange(""); // initial sort, index assignment, etc
    items.forEach((item) => {
      item.savedText = item.text;
      item.savedTime = item.time;
    });
  }

  function stableSort(array, compare) {
    return array
      .map((item, index) => ({ item, index }))
      .sort((a, b) => compare(a.item, b.item) || a.index - b.index)
      .map(({ item }) => item);
  }

  function itemTags(lctext): Array<string> {
    return Array.from(lctext.matchAll(/(?:^|\s)(#[\/\w]+)/g), (m) => m[1]);
  }

  function onEditorChange(text: string) {
    text = text.toLowerCase().trim();
    // let terms = [...new Set(text.split(/[^#\/\w]+/))].filter((t) => t);
    let terms = [
      ...new Set(text.split(/\s+/).concat(text.split(/[^#\/\w]+/))),
    ].filter((t) => t);
    if (text.startsWith("/")) terms = [];
    let termsSecondary = [];
    terms.forEach((term) => {
      if (term[0] != "#") return;
      let pos;
      let tag = term;
      while ((pos = tag.lastIndexOf("/")) >= 0)
        termsSecondary.push((tag = tag.slice(0, pos)));
    });

    // let matchingTermCounts = new Map<string, number>();
    let matchingItemCount = 0;
    let listing = [];
    items.forEach((item) => {
      const lctext = item.text.toLowerCase();
      item.tags = itemTags(lctext);
      // first tag is taken as "label" if it is the first text in the item
      item.label = lctext.startsWith(item.tags[0]) ? item.tags[0] : "";

      // NOTE: alphanumeric ordering (e.g. on pinTerm) must always be preceded with a prefix match condition
      //       (otherwise the default "" would always be on top unless you use something like "ZZZ")
      const pintags = item.tags.filter((t) => t.match(/^#_?pin(?:\/|$)/));
      item.pinned = pintags.length > 0;
      item.pinTerm = pintags[0] || "";
      item.prefixMatch = lctext.startsWith(terms[0]);
      item.prefixMatchTerm = "";
      if (item.prefixMatch) {
        item.prefixMatchTerm =
          terms[0] + lctext.substring(terms[0].length).match(/^[\/\w]*/)[0];
      }
      // use first exact-match item as "listing" item
      if (item.prefixMatchTerm == terms[0] && listing.length == 0)
        listing = item.tags.reverse(); // so that last is best and default (-1) is worst

      item.matchingTerms = [];
      if (item.pinned) {
        // match only tags for pinned items
        // item.matchingTerms = terms.filter((t) => item.tags.indexOf(t) >= 0);
        item.matchingTerms = terms.filter(
          (t) => item.tags.findIndex((tag) => tag.startsWith(t)) >= 0
        );
      } else {
        item.matchingTerms = terms.filter((t) => lctext.indexOf(t) >= 0);
      }
      if (item.matchingTerms.length > 0) {
        matchingItemCount++;
        // item.matchingTerms.forEach((term) =>
        //   matchingTermCounts.set(term, (matchingTermCounts.get(term) || 0) + 1)
        // );
      }
      item.matchingTermsSecondary = [];
      item.matchingTermsSecondary = termsSecondary.filter(
        (t) => lctext.indexOf(t) >= 0
      );
    });

    // Store matching item/term counts in items
    items.forEach((item) => {
      item.matchingItemCount = matchingItemCount;
      // item.matchingTermCounts = [];
      // item.matchingTerms.forEach((term) =>
      //   item.matchingTermCounts.push(matchingTermCounts.get(term))
      // );
    });

    // Update times for editing items to maintain their ordering when one is saved
    let now = Date.now();
    items.forEach((item) => {
      if (item.editing && !item.text.match(/(?:^|\s)#log(?:\s|$)/))
        item.time = now;
    });

    // NOTE: undefined values produce NaN, which is treated as 0
    items = stableSort(items, (a, b) => {
      // pinned (contains #pin)
      return (
        b.pinned - a.pinned ||
        // alphanumeric ordering on #pin/* term
        a.pinTerm.localeCompare(b.pinTerm) ||
        // position in item with exact match on first term
        listing.indexOf(b.prefixMatchTerm) -
          listing.indexOf(a.prefixMatchTerm) ||
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
    updateItemIndices();
  }

  function onTagClick(tag: string) {
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
        text = `${new Date(item.time)}\n${new Date(
          item.updateTime
        )}\n${new Date(item.createTime)}`;
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
        location.href =
          "twitter://post?message=" + encodeURIComponent(item.text);
        return;
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
          text = "```js_input\n" + text.replace(/\/js\s*/, "").trim() + "\n```";
        } else if (text.startsWith("/")) {
          alert(`unknown command ${text}`);
          return;
        }
        text = appendJSOutput(text);
        editing = text.length == 0; // if text is empty, continue editing
      }
    }
    let tmpid = Date.now().toString();
    let itemToSave = { time: time, text: text };
    let item = { ...itemToSave, id: tmpid, saving: true, editing: editing };
    items = [item, ...items];
    editorText = "";
    onEditorChange(editorText);
    textArea(-1).focus();
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
        items[index].saving = false; // assigning to item object in array triggers dom update for item
        items[index].savedText = text;
        items[index].savedTime = time;
        items[index].id = doc.id;
        indexFromId.set(doc.id, index);
        indexFromId.delete(tmpid);
        if (focusedItem == index)
          // maintain focus through id change ...
          setTimeout(() => textArea(indexFromId.get(doc.id)).focus(), 0);
        // also save to items-history ...
        firestore()
          .collection("items-history")
          .add({ item: doc.id, ...itemToSave })
          .catch(console.error);
      })
      .catch((error) => {
        console.error(error);
        items[0].error = true;
      });
  }

  function focusOnNearestEditingItem(index: number) {
    // console.log("focusOnNearestEditingItem, editingItems",editingItems)
    let near = Math.min.apply(
      null,
      editingItems.filter((i) => i > index)
    );
    if (near == Infinity) near = Math.max.apply(null, [-1, ...editingItems]);
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
  function onItemResized(id: string, height: number) {
    const index = indexFromId.get(id);
    if (index == undefined) return; // item was deleted
    if (height == 0 && items[index].height > 0) {
      console.warn(
        `zero height (last known height ${items[index].height}) for item ${id} at index ${index}`,
        items[index].text.substring(0, Math.min(items[index].text.length, 80))
      );
    }
    if (items[index].height != height) {
      // height change, trigger layout in 250ms
      if (!layoutPending) {
        console.log(
          `updating layout due to height change (${items[index].height} to ${height}) for item ${id} at index ${index}`,
          items[index].text.substring(0, Math.min(items[index].text.length, 80))
        );
        layoutPending = true;
        setTimeout(() => {
          onEditorChange(editorText);
          layoutPending = false;
        }, 250);
      } else if (items[index].height != 0) {
        // also log non-trivial height change
        // console.log(
        //   `height change (${items[index].height} to ${height}) for item ${id} at index ${index}`,
        //   items[index].text.substring(0, Math.min(items[index].text.length, 80))
        // );
      }
      items[index].height = height;
    }
  }

  function extractBlock(text: string, type: string) {
    // NOTE: this logic is consistent with onInput() in Editor.svelte
    let insideBlock = false;
    let regex = RegExp("^```" + type + "(\\s|$)");
    return text
      .split("\n")
      .map((line) => {
        if (!insideBlock && line.match(regex)) insideBlock = true;
        else if (insideBlock && line.match(/^```/)) insideBlock = false;
        if (line.match(/^```/)) return "";
        return insideBlock ? line : "";
      })
      .filter((t) => t)
      .join("\n")
      .trim();
  }

  let evalIndex = -1;
  function evalJSInput(
    text: string,
    label: string = "",
    index: number = -1
  ): string {
    const jsin = extractBlock(text, "js_input");
    if (jsin.length == 0) return "";

    try {
      evalIndex = index;
      let out = eval("(function(){" + jsin + "})()");
      evalIndex = -1;
      return out;
    } catch (e) {
      evalIndex = -1;
      let msg = e.toString();
      if (label) msg = label + ": " + msg;
      alert(msg);
      return undefined;
    }
  }

  function appendBlock(text: string, type: string, block: string) {
    block = "\n```" + type + "\n" + block + "\n```";
    const regex = "\\n```" + type + "\\n.*?\\n```";
    if (text.match(RegExp(regex, "s"))) {
      text = text.replace(RegExp(regex, "gs"), block);
    } else {
      text += block;
    }
    return text;
  }

  function appendJSOutput(text: string, index: number = -1): string {
    if (!text.match(/```js_input\s/)) return text; // no js code in text
    // execute JS code, including any tag-referenced items (using latest tags/label)
    const lctext = text.toLowerCase();
    const tags = itemTags(lctext);
    const label = lctext.startsWith(tags[0]) ? tags[0] : "";
    let jsout = [];
    tags.forEach((tag) => {
      if (tag == label) return;
      const indices = indicesFromLabel.get(tag) || [];
      indices.forEach((index) => {
        jsout.push(
          evalJSInput(items[index].text, items[index].label) || "",
          index
        );
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
      [
        "iPad Simulator",
        "iPhone Simulator",
        "iPod Simulator",
        "iPad",
        "iPhone",
        "iPod",
      ].includes(navigator.platform) ||
      // iPad on iOS 13 detection
      (navigator.userAgent.includes("Mac") && "ontouchend" in document)
    );
  }

  function onItemEditing(index: number, editing: boolean) {
    let item = items[index];
    // for non-log items, update time whenever the item is "touched"
    if (!item.text.match(/(?:^|\s)#log(?:\s|$)/)) item.time = Date.now();

    if (editing) {
      // started editing
      editingItems.push(index);
      onEditorChange(editorText);
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
      if (focusedItem == index) {
        focusedItem = -1;

        if (item.text.length == 0) {
          // delete
          items.splice(index, 1);
          updateItemIndices();
          items = items; // trigger dom update
          deletedItems.unshift({
            time: item.savedTime,
            text: item.savedText,
          }); // for /undelete
          firestore()
            .collection("items")
            .doc(item.id)
            .delete()
            .catch(console.error);
        } else {
          // empty out any *_output blocks as they should be re-generated
          item.text = item.text.replace(
            /\n```(\w*?_output)\n.*?\n```/gs,
            "\n```$1\n\n```"
          );
          // console.log(item.text);
          // NOTE: these appends may trigger async _write
          item.text = appendJSOutput(item.text, index);
          if (item.time != item.savedTime || item.text != item.savedText)
            saveItem(index);
          onEditorChange(editorText); // update sorting of items (at least time or text has changed)
        }

        // NOTE: we do not focus back up on the editor on the iPhone as it can cause a disorienting jump
        //       that is not worth the benefit without an attached keyboard (which is harder to detect)
        if (
          editingItems.length > 0 ||
          !navigator.platform.startsWith("iPhone")
        ) {
          focusOnNearestEditingItem(index);
        } else {
          (document.activeElement as HTMLElement).blur();
        }
      }
    }
    // console.log(`item ${index} editing: ${editing}, editingItems:${editingItems}, focusedItem:${focusedItem}`);
  }

  function onItemFocused(index: number, focused: boolean) {
    if (focused) focusedItem = index;
    else focusedItem = -1;
    // console.log(`item ${index} focused: ${focused}, focusedItem:${focusedItem}`);
  }

  function editItem(index: number) {
    items[index].editing = true;
    editingItems.push(index);
  }

  function textArea(index: number): HTMLTextAreaElement {
    return document.getElementById(
      "textarea-" + (index < 0 ? "editor" : items[index].id)
    ) as HTMLTextAreaElement;
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

  function disableEditorShortcuts(e: KeyboardEvent) {
    // disable save/forward/back shortcuts on window, focus on editor instead
    if (focusedItem >= 0) return; // already focused on an item
    if (
      (e.code == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) ||
      (e.code == "KeyS" && (e.metaKey || e.ctrlKey)) ||
      ((e.code == "BracketLeft" || e.code == "BracketRight") &&
        (e.metaKey || e.ctrlKey))
    ) {
      e.preventDefault();
      textArea(-1).focus();
      window.top.scrollTo(0, 0);
    }
  }

  if (isClient) {
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
                console.log("updated cookie", error || "no error");
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
      onEditorChange(
        (editorText = (editorText.trim() + " " + text).trimStart())
      );
    };
    window["_append_edit"] = function (text: string) {
      onEditorChange(
        (editorText = (editorText.trim() + " " + text).trim() + " ")
      );
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
            window["_append_edit"](
              `${prefix}[${title || url.host}](${urlstr})${suffix}`
            );
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
      let query = editorText.trim();
      onEditorChange((editorText = ""));
      window.open("https://google.com/search?q=" + encodeURIComponent(query));
    };
    window["_tweet"] = function () {
      let tweet = editorText.trim();
      onEditorChange((editorText = ""));
      if (tweet == "") {
        onEditorDone("/tweet", null);
      } else {
        location.href = "twitter://post?message=" + encodeURIComponent(tweet);
      }
    };
    window["_eval"] = function (tag: string) {
      const indices = indicesFromLabel.get(tag) || [];
      const jsout = indices.map((index) =>
        evalJSInput(items[index].text, items[index].label)
      );
      return jsout.length == 1 ? jsout[0] : jsout;
    };

    function indicesForItem(item: string) {
      if (item == "" && evalIndex >= 0) {
        return [evalIndex];
      } else if (
        item == "" &&
        window["_script_item_id"] &&
        indexFromId.has(window["_script_item_id"])
      ) {
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

    window["_read"] = function (type: string = "", item: string = "") {
      let content = [];
      let indices = indicesForItem(item);
      indices.map((index) => {
        if (type == "") content.push(items[index].text);
        else content.push(extractBlock(items[index].text, type));
      });
      return content.length == 1 ? content[0] : content;
    };

    window["_write"] = function (
      item: string,
      text: string,
      type: string = "_output"
    ) {
      // NOTE: write is always async in case triggered by eval during onItemEditing
      setTimeout(() => {
        let indices = indicesForItem(item);
        indices.map((index) => {
          if (items[index].editing) {
            console.log("can not _write to item while editing");
            return;
          }
          const prevSaveClosure = items[index].saveClosure;
          const saveClosure = (index) => {
            if (type == "") items[index].text = text;
            else items[index].text = appendBlock(items[index].text, type, text);
            if (prevSaveClosure) prevSaveClosure(index); // chain closures
            items[index].time = Date.now();
            onEditorChange(editorText);
            saveItem(index);
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

    // Visual viewport resize/scroll handlers ...
    // NOTE: These seem to respond to font resizing also, so no need for polling below
    let lastScrollTime = 0;
    let lastOuterWidth = 0;
    let lastOuterHeight = 0;
    visualViewport.addEventListener("scroll", (e) => {
      lastScrollTime = Date.now();
    });
    let resizePending = false;
    function tryResize() {
      // NOTE: no need to ignore while zooming as long as we use outer width/height
      // if (visualViewport.scale > 1) return; // ignore while zooming
      if (Date.now() - lastScrollTime > 250) {
        if (outerWidth != lastOuterWidth || outerHeight != lastOuterHeight) {
          onEditorChange(editorText);
          lastOuterWidth = outerWidth;
          lastOuterHeight = outerHeight;
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

    // Restore user from localStorage for faster init
    // NOTE: Making the user immediately available creates two problems: (1) user.photoURL returns 403 (even though URL is the same and even if user object is maintained in onAuthStateChanged), (2) initial editor focus fails mysteriously. Both problems are fixed if we condition these elements on a loggedIn flag set to true in onAuthStateChanged call from firebase auth.
    if (!user && localStorage.getItem("user")) {
      user = JSON.parse(localStorage.getItem("user"));
      console.log("restored user from local storage");
    }
    console.log("first script run, items:", items.length);
  }

  import { onMount, onDestroy } from "svelte";
  let pollingInterval = 0;
  onMount(() => {
    // NOTE: invoking onEditorChange on a timeout allows item heights to be available for paging
    setTimeout(() => onEditorChange(""), 0);
    // pollingInterval = setInterval(()=>{}, 250)
  });
  onDestroy(() => clearInterval(pollingInterval));
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
    /* max-width same as .super-container in Item.svelte */
    max-width: 750px;
    padding-bottom: 8px;
  }
  #header-container {
    display: flex;
    padding: 4px 0;
    border-left: 2px solid #444;
    background: #1b1b1b; /* matches unfocused editor */
  }
  #header-container.focused {
    background: #1b1b1b;
    border-left: 2px solid #aaa;
  }
  #editor {
    margin-right: 4px;
    width: 100%;
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
  .items {
    column-count: auto;
    column-fill: balance;
    column-width: 500px; /* minimum width; max-width is on #header and .super-container (in Item.svelte) */
    column-gap: 0;
    /* margin-top: 4px; */
  }
  .page-separator {
    column-span: all;
    display: block;
    height: 1px;
    border-top: 1px dashed #444;
    margin: 20px 0;
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

  {#each pages as page}
    <div class="items">
      {#if page == 0}
        <div id="header" on:click={() => textArea(-1).focus()}>
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
            {#if loggedIn}
              <img
                id="user"
                src={user.photoURL}
                alt={user.email}
                on:click={signOut} />
            {/if}
          </div>
        </div>
        <!-- auto-focus on the editor unless on iPhone -->
        {#if loggedIn}
          <script>
            // NOTE: we do not focus on the editor on the iPhone, which generally does not allow
            //       autofocus except in certain unexpected situations (like coming back to app)
            if (!navigator.platform.startsWith("iPhone"))
              document.getElementById("textarea-editor").focus();
          </script>
        {/if}
      {/if}

      {#if page > 0}
        <div class="page-separator" />
      {/if}

      {#each items as item (item.id)}
        <!-- NOTE: we are currently iterating over all items once for each page, but that should be ok for now -->
        <!-- (splitting into a pages array caused update issues that are not worth debugging right now) -->
        {#if item.page == page}
          <!-- NOTE: pageStart based splitting was slow unless we allowed breaking inside items, which caused spurious height changes -->
          <!-- {#if item.pageStart} <div class="page-separator" /> {/if} -->
          <!-- WARNING: Binding does not work for asynchronous updates since the underlying component may be destroyed -->
          <Item
            onEditing={onItemEditing}
            onFocused={onItemFocused}
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
            index={item.index}
            itemCount={items.length}
            matchingItemCount={item.matchingItemCount}
            matchingTerms={item.matchingTerms.join(' ')}
            matchingTermsSecondary={item.matchingTermsSecondary.join(' ')}
            timeString={item.timeString}
            timeOutOfOrder={item.timeOutOfOrder}
            updateTime={item.updateTime}
            createTime={item.createTime} />
        {/if}
      {/each}
    </div>
  {/each}
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

<svelte:window on:keypress={disableEditorShortcuts} />
