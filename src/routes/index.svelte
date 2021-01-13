<script context="module" lang="ts">
  import _ from "lodash";

  import {
    isClient,
    firebase,
    firestore,
    firebaseAdmin,
  } from "../../firebase.js";
  const allowedUsers = ["y2swh7JY2ScO5soV7mJMHVltAOX2"]; // user.uid for olcans@gmail.com

  // NOTE: Preload function can be called on either client or server
  // See https://sapper.svelte.dev/docs#Preloading
  export async function preload(page, session) {
    // console.debug("preloading, client?", isClient);
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
  import { Circle2, DoubleBounce } from "svelte-loading-spinners";
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
    else blurOnNextCancel = editorText == ""; // blur on next cancel (e.g. escape) if empty
  }

  function itemTimeString(delta: number) {
    if (delta < 60) return "<1m";
    if (delta < 3600) return Math.floor(delta / 60).toString() + "m";
    if (delta < 24 * 3600) return Math.floor(delta / 3600).toString() + "h";
    return Math.floor(delta / (24 * 3600)).toString() + "d";
  }

  let indexFromId;
  let headerdiv;
  let consolediv;
  let dotCount = 0;
  let columnCount = 0;
  let oldestTime = Infinity;
  let oldestTimeString = "";
  let maxIndexToShowDefault = 50;
  let maxIndexToShow = maxIndexToShowDefault;
  function updateItemLayout() {
    // console.debug("updateItemLayout");
    editingItems = [];
    focusedItem = -1;
    indexFromId = new Map<string, number>();
    dotCount = 0;

    // NOTE: we use document width as it scales with font size consistently on iOS and Mac
    const documentWidth = document.documentElement.clientWidth;
    const minColumnWidth = 500; // minimum column width for multiple columns
    columnCount = Math.max(1, Math.floor(documentWidth / minColumnWidth));
    let columnHeights = new Array(columnCount).fill(0);
    let columnItems = new Array(columnCount).fill(-1);
    columnHeights[0] = headerdiv ? headerdiv.offsetHeight : 0; // first column includes header
    let lastTimeString = "";
    let topMovedIndex = items.length;

    items.forEach((item, index) => {
      if (index < item.index && index < topMovedIndex) topMovedIndex = index;
      item.index = index;
      indexFromId.set(item.id, index);
      if (item.dotted) dotCount++;
      if (item.editing) editingItems.push(index);
      if (item.focused) focusedItem = index;

      let lastItem = items[index - 1];
      let timeString = itemTimeString((Date.now() - item.time) / 1000);
      if (item.time < oldestTime) {
        oldestTime = item.time;
        oldestTimeString = timeString;
      }

      item.timeString = "";
      item.timeOutOfOrder = false;
      if (!item.pinned && (index == 0 || timeString != lastTimeString)) {
        item.timeString = timeString;
        item.timeOutOfOrder =
          index > 0 &&
          !lastItem.pinned &&
          item.time > lastItem.time &&
          timeString != lastTimeString;
      }
      lastTimeString = timeString;

      // determine item column
      item.nextColumn = -1;
      item.nextItemInColumn = -1;
      item.outerHeight = (item.height || 100) + 8 + (item.timeString ? 24 : 0); // item + margins + time string
      if (item.dotted) item.outerHeight = 0; // ignore height of dotted items
      if (index == 0) item.column = 0;
      else {
        // stay on same column unless column height would exceed minimum column height by 90% of screen height
        const lastColumn = lastItem.column;
        const minColumnHeight = Math.min(...columnHeights);
        if (
          columnHeights[lastColumn] <= minColumnHeight + 0.5 * outerHeight ||
          columnHeights[lastColumn] + item.outerHeight + 40 <=
            minColumnHeight + 0.9 * outerHeight
        )
          item.column = lastColumn;
        else item.column = columnHeights.indexOf(minColumnHeight);
        if (item.column != lastColumn) {
          lastItem.nextColumn = item.column;
          lastItem.arrows = item.column < lastColumn ? "↖" : "";
          for (let i = 0; i < Math.abs(item.column - lastColumn) - 1; ++i)
            lastItem.arrows += item.column < lastColumn ? "←" : "→";
          lastItem.arrows += item.column < lastColumn ? "" : "↗";
          columnHeights[lastColumn] += 40; // .section-separator height including margins
        }
      }
      // if item is first in column and missing time string, add it now (unless dotted)
      if (columnHeights[item.column] == 0 && !item.timeString && !item.dotted) {
        item.timeString = timeString;
        item.outerHeight += 24;
      }

      columnHeights[item.column] += item.outerHeight;
      if (columnItems[item.column] >= 0) {
        items[columnItems[item.column]].nextItemInColumn = index;
        // if item is below section-separator and has timeString, discount -24px negative margin
        if (columnItems[item.column] != index - 1 && item.timeString)
          columnHeights[item.column] -= 24;
      }
      columnItems[item.column] = index;
    });

    if (focusedItem >= 0) {
      // console.debug("updateItemLayout focusedItem", focusedItem);
      // maintain focus on item
      const textarea = textArea(focusedItem);
      if (textarea) setTimeout(() => textarea.focus(), 0); // allow dom update before refocus
    } else if (Date.now() - editorBlurTime < 250) {
      // refocus on editor if it was unfocused within last .25 seconds
      textArea(-1).focus();
    }
    // scroll up to top moved item if necessary
    if (topMovedIndex < items.length) {
      setTimeout(() => {
        // allow dom update before calculating new position
        const div = document.querySelector(
          "#super-container-" + items[topMovedIndex].id
        );
        if (!div) return; // item hidden
        const itemTop = (div as HTMLElement).offsetTop;
        if (itemTop < window.scrollY) {
          // console.debug("scrolling up", itemTop, window.scrollY);
          window.top.scrollTo(0, itemTop);
        }
      });
    }
  }

  function stableSort(array, compare) {
    return array
      .map((item, index) => ({ item, index }))
      .sort((a, b) => compare(a.item, b.item) || a.index - b.index)
      .map(({ item }) => item);
  }

  // NOTE: Invoke onEditorChange only editor text and/or item content has changed.
  //       Invoke updateItemLayout directly if only item sizes have changed.
  const editorDebounceTime = 500;
  let lastEditorChangeTime = 0;
  let matchingItemCount = 0;
  let textLength = 0;
  let editorChangePending = false;
  function onEditorChange(text: string) {
    // if editor is non-empty, has focus, and it is too soon since last change/return, debounce
    if (
      text &&
      document.activeElement == textArea(-1) &&
      Date.now() - lastEditorChangeTime < editorDebounceTime
    ) {
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
    // console.debug("onEditorChange");
    maxIndexToShow = maxIndexToShowDefault; // reset item truncation

    // update history, replace unless current state is final
    if (history.state.editorText != text) {
      // need to update history
      if (history.state.final) history.pushState({ editorText: text }, text);
      else history.replaceState({ editorText: text }, text);
    }

    text = text.toLowerCase().trim();
    let terms = [
      ...new Set(
        text
          .split(/\s+/)
          // .concat(text.split(/[.,!$%\^&\*;:{}=\-`~()]/))
          .concat(parseTags(text).all)
      ),
    ].filter((t) => t);
    // if (text.startsWith("/")) terms = [];

    // expand tag prefixes into termsSecondary
    let termsSecondary = [];
    terms.forEach((term) => {
      if (term[0] != "#") return;
      let pos;
      let tag = term;
      while ((pos = tag.lastIndexOf("/")) >= 0)
        termsSecondary.push((tag = tag.slice(0, pos)));
    });

    matchingItemCount = 0;
    textLength = 0;
    let listing = [];
    let listingLabelPrefixes = [];
    items.forEach((item) => {
      textLength += item.text.length;

      // NOTE: any alphanumeric ordering (e.g. on pinTerm) must always be preceded with a prefix match condition
      //       (otherwise the default "" would always be on top unless you use something like "ZZZ")

      // match first query term against item label
      item.labelMatch = item.label == terms[0];

      // match first query term against visible tags in item
      item.tagMatch = item.tagsVisible.indexOf(terms[0]) >= 0;

      // prefix-match first query term against item header text (excluding html preamble)
      item.prefixMatch = item.header.startsWith(terms[0]);

      // find "pinned match" term = tags containing /pin with prefix match on first term
      item.pinnedMatchTerm =
        item.tags.find(
          (t) => t.startsWith(terms[0]) && t.match(/\/pin(?:\/|$)/)
        ) || "";
      item.pinnedMatch = item.pinnedMatchTerm.length > 0;

      // detect "listing" item w/ unique label matching first term
      // (in reverse order w/ listing item label last so larger is better and missing=-1)
      if (item.labelUnique && item.label == terms[0]) {
        listingLabelPrefixes = item.labelPrefixes;
        listing = item.tagsVisible
          .filter((t) => t != item.label)
          .slice()
          .reverse()
          .concat(item.label);
      }

      // match non-tag terms (anywhere in text)
      item.matchingTerms = terms.filter(
        (t) => t[0] != "#" && item.lctext.indexOf(t) >= 0
      );
      // match tags against item tags, allowing prefix matches
      item.matchingTerms = item.matchingTerms.concat(
        terms.filter(
          (t) =>
            t[0] == "#" && item.tags.findIndex((tag) => tag.startsWith(t)) >= 0
        )
      );
      // match regex:* terms
      item.matchingTerms = item.matchingTerms.concat(
        terms.filter(
          (t) =>
            t.match(/^regex:\S+/) &&
            item.lctext.match(new RegExp(t.substring(6)))
        )
      );
      // match id:* terms
      item.matchingTerms = item.matchingTerms.concat(
        terms.filter(
          (t) => t.match(/^id:\S+/) && item.id.toLowerCase() == t.substring(3)
        )
      );

      // match secondary terms (tag prefixes)
      item.matchingTermsSecondary = termsSecondary.filter(
        (t) => item.tagsExpanded.indexOf(t) >= 0
      );

      // item is considered matching if primary terms match
      // (i.e. secondary terms are used only for ranking and highlighting matching tag prefixes)
      // (this is consistent with .index.matching in Item.svelte)
      if (item.matchingTerms.length > 0) matchingItemCount++;

      // calculate missing tags (excluding certain special tags from consideration)
      // NOTE: doing this here is easier than keeping these updated in itemTextChanged
      item.missingTags = item.tags.filter(
        (t) =>
          t != item.label &&
          t != "#log" &&
          t != "#menu" &&
          !t.match(/^#pin(?:\/|$)/) &&
          !t.match(/\/pin(?:\/|$)/) &&
          (tagCounts.get(t) || 0) <= 1
      );
      // if (item.missingTags.length > 0) console.log(item.missingTags, item.tags);

      item.hasError = item.text.match(/(?:^|\n)(?:ERROR|WARNING):/) != null;
    });

    // Update (but not save yet) times for editing and running items to maintain ordering
    // among running/editing items within their sort level (see ordering logic below)
    let now = Date.now();
    items.forEach((item) => {
      if ((item.editing || item.running) && !item.log) item.time = now;
    });

    // returns position of minimum non-negative number, or -1 if none found
    function min_pos(xJ) {
      let jmin = -1;
      for (let j = 0; j < xJ.length; ++j)
        if (xJ[j] >= 0 && (jmin < 0 || xJ[j] < xJ[jmin])) jmin = j;
      return jmin;
    }

    // NOTE: this assignment is what mainly triggers toHTML in Item.svelte
    //       (even assigning a single index, e.g. items[0]=items[0] triggers toHTML on ALL items)
    //       (afterUpdate is also triggered by the various assignments above)
    // NOTE: undefined values produce NaN, which is treated as 0
    items = stableSort(
      items,
      (a, b) =>
        // dotted? (contains #pin/dot or #pin/dot/*)
        b.dotted - a.dotted ||
        // alphanumeric ordering on #pin/dot/* term
        a.dotTerm.localeCompare(b.dotTerm) ||
        // pinned? (contains #pin or #pin/*)
        b.pinned - a.pinned ||
        // alphanumeric ordering on #pin/* term
        a.pinTerm.localeCompare(b.pinTerm) ||
        // pinned match? (contains /pin or /pin/*)
        b.pinnedMatch - a.pinnedMatch ||
        // alphanumeric ordering on #*/pin/* term
        a.pinnedMatchTerm.localeCompare(b.pinnedMatchTerm) ||
        // listing item label prefix match length (for context for listing item)
        listingLabelPrefixes.indexOf(b.label) -
          listingLabelPrefixes.indexOf(a.label) ||
        // position of label in listing item (item w/ unique label = first term)
        // (listing is reversed so larger index is better and missing=-1)
        listing.indexOf(b.label) - listing.indexOf(a.label) ||
        // editing mode (except log items)
        (!b.log && b.editing) - (!a.log && a.editing) ||
        // label match on first term
        b.labelMatch - a.labelMatch ||
        // tag match on first term
        b.tagMatch - a.tagMatch ||
        // position of longest matching label prefix in listing item
        min_pos(listing.map((pfx) => b.labelPrefixes.indexOf(pfx))) -
          min_pos(listing.map((pfx) => a.labelPrefixes.indexOf(pfx))) ||
        // prefix match on first term
        b.prefixMatch - a.prefixMatch ||
        // # of matching words
        b.matchingTerms.length - a.matchingTerms.length ||
        // # of matching secondary words
        b.matchingTermsSecondary.length - a.matchingTermsSecondary.length ||
        // missing tag prefixes
        b.missingTags.length - a.missingTags.length ||
        // errors
        b.hasError - a.hasError ||
        // time (most recent first)
        b.time - a.time
    );
    updateItemLayout();
    lastEditorChangeTime = Infinity; // force minimum wait for next change
    if (items.length > 0) setTimeout(updateDotted, 0); // show/hide dotted/undotted items
  }

  function onTagClick(tag: string, reltag: string, e: MouseEvent) {
    if (tag == reltag) {
      // calculate partial tag prefix (e.g. #tech for #tech/math) based on position of click
      let range = document.caretRangeFromPoint(
        e.pageX - document.documentElement.scrollLeft,
        e.pageY - document.documentElement.scrollTop
      );
      if (range) {
        let tagNode = e.target as Node;
        // if target is not the tag node, it must be a highlight, so we move to the parent
        if ((tagNode as HTMLElement).tagName != "MARK")
          tagNode = tagNode.parentNode;
        // console.debug("tag click: ", range.startOffset, clickNode, tagNode.childNodes);
        // if tag node contains highlight, we have to adjust click position
        let pos = range.startOffset;
        for (const child of Array.from(tagNode.childNodes)) {
          if (child.contains(range.startContainer)) break;
          pos += child.textContent.length;
        }
        // we only take partial tag if the current tag is "selected" (i.e. full exact match)
        // (makes it easier to click on tags without accidentally getting a partial tag)
        // if ((tagNode as HTMLElement).classList.contains("selected"))
        tag = tag.substring(0, pos) + tag.substring(pos).match(/^[^\/]*/)[0];
      } else {
        console.warn("got null range for tag click: ", tag, e);
      }
    }
    tag = tag.replace(/^#_/, "#"); // ignore hidden tag prefix
    editorText = editorText.trim() == tag ? "" : tag + " "; // space in case more text is added
    // push new state with "final" flag so it is not modified by onEditorChange
    history.pushState({ editorText: editorText, final: true }, editorText);
    onEditorChange(editorText);
  }

  function onLogSummaryClick(id: string) {
    let index = indexFromId.get(id);
    if (index == undefined) return;
    items[index].showLogs = !items[index].showLogs;
    items[index].showLogsTime = Date.now(); // invalidates auto-hide
  }

  function onPopState(e) {
    if (!e?.state) return; // for fragment (#id) hrefs
    editorText = e.state.editorText || "";
    onEditorChange(editorText);
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

  let idsFromLabel = new Map<string, string[]>();
  function itemDeps(index, deps = []) {
    let item = items[index];
    if (deps.indexOf(item.id) >= 0) return deps;
    // NOTE: dependency order matters for hashing and potentially for code import
    deps = [item.id, ...deps]; // prepend temporarily to avoid cycles, moved to back below
    item.tags.forEach((tag) => {
      if (tag == item.label) return;
      if (!idsFromLabel.has(tag)) return;
      const ids = idsFromLabel.get(tag);
      if (ids.length > 1) return; // only unique labels can have dependents
      ids.forEach((id) => {
        const dep = indexFromId.get(id);
        if (dep == undefined) return; // deleted
        deps = itemDeps(dep, deps);
      });
    });
    return deps.slice(1).concat(item.id);
  }

  let tagCounts = new Map<string, number>();
  function itemTextChanged(index: number, text: string, update_deps = true) {
    // console.debug("itemTextChanged", index);
    let item = items[index];
    item.hash = hashCode(text);
    item.lctext = text.toLowerCase();
    item.runnable = item.lctext.match(/\s*```js_input\s/);
    item.scripted = item.lctext.match(/<script.*?>/);
    item.macroed = item.lctext.match(/<<.*?>>/);

    const tags = parseTags(item.lctext);
    item.tags = tags.all;
    item.tagsVisible = tags.visible;
    item.log = item.tags.indexOf("#log") >= 0;
    item.debug = item.tags.indexOf("#debug") >= 0;
    const pintags = item.tags.filter((t) => t.match(/^#pin(?:\/|$)/));
    item.pinned = pintags.length > 0;
    item.pinTerm = pintags[0] || "";
    item.dotted = pintags.findIndex((t) => t.match(/^#pin\/dot(?:\/|$)/)) >= 0;
    item.dotTerm =
      pintags.filter((t) => t.match(/^#pin\/dot(?:\/|$)/))[0] || "";

    // if item stats with a visible tag, it is taken as a "label" for the item
    // (we allow some tags/macros to precede the label tag for styling purposes)
    const prevLabel = item.label;
    item.header = item.lctext
      .replace(/^<.*>\s+#/, "#")
      .match(/^.*?(?:\n|$)/)[0];
    item.label = item.header.startsWith(item.tagsVisible[0])
      ? item.tagsVisible[0]
      : "";
    if (item.labelUnique == undefined) item.labelUnique = false;
    if (item.labelPrefixes == undefined) item.labelPrefixes = [];
    if (item.label) {
      // convert relative tags to absolute
      item.tags = item.tags.map((tag) =>
        tag.startsWith("#/") ? item.label + tag.substring(1) : tag
      );
      item.tagsVisible = item.tagsVisible.map((tag) =>
        tag.startsWith("#/") ? item.label + tag.substring(1) : tag
      );
    }
    if (item.label != prevLabel) {
      item.labelUnique = false;
      if (prevLabel) {
        const ids = idsFromLabel.get(prevLabel).filter((id) => id != item.id);
        idsFromLabel.set(prevLabel, ids);
        if (ids.length == 1) items[indexFromId.get(ids[0])].labelUnique = true;
      }
      if (item.label) {
        const ids = (idsFromLabel.get(item.label) || []).concat(item.id);
        idsFromLabel.set(item.label, ids);
        item.labelUnique = ids.length == 1;
        if (ids.length == 2) items[indexFromId.get(ids[0])].labelUnique = false;
      }
      item.labelPrefixes = [];
      let label = item.label;
      let pos;
      while ((pos = label.lastIndexOf("/")) >= 0)
        item.labelPrefixes.push((label = label.slice(0, pos)));
    }

    // compute expanded tags including prefixes
    const prevTagsExpanded = item.tagsExpanded || [];
    item.tagsExpanded = item.tags.slice();
    item.tags.forEach((tag) => {
      let pos;
      while ((pos = tag.lastIndexOf("/")) >= 0)
        item.tagsExpanded.push((tag = tag.slice(0, pos)));
    });
    if (!_.isEqual(item.tagsExpanded, prevTagsExpanded)) {
      prevTagsExpanded.forEach((tag) =>
        tagCounts.set(tag, tagCounts.get(tag) - 1)
      );
      item.tagsExpanded.forEach((tag) =>
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
      );
    }

    if (update_deps) {
      item.deps = itemDeps(index);
      const prevDeepHash = item.deephash;
      item.deephash = hashCode(
        item.deps.map((id) => items[indexFromId.get(id)].hash).join(",")
      );
      if (item.deephash != prevDeepHash && !item.log) item.time = Date.now();
      // we have to update deps/deephash for all dependent items
      // NOTE: changes to deephash trigger re-rendering and cache invalidation
      items.forEach((depitem, depindex) => {
        if (depindex == index) return; // skip self
        // NOTE: we only need to update dependencies if item label has changed
        if (prevLabel != item.label) depitem.deps = itemDeps(depindex);
        if (depitem.deps.length > 1 && depitem.deps.indexOf(item.id) >= 0) {
          const prevDeepHash = depitem.deephash;
          // NOTE: updating deephash automatically triggers rendering of dependents
          depitem.deephash = hashCode(
            depitem.deps.map((id) => items[indexFromId.get(id)].hash).join(",")
          );
          // // update/save scripted dependents
          // if (depitem.deephash != prevDeepHash && depitem.scripted) {
          //   // update times, offset to maintain existing ordering, with dependency most recent
          //   if (!depitem.log) depitem.time = item.time - 1 - depindex;
          //   // console.debug("saving scripted dependent", depindex);
          //   saveItem(depitem.id);
          // }
        }
      });
    }
  }

  let lastEvalText; // filled in _eval()
  let lastRunText; // filled in appendJSOutput() and _webppl_run
  function addLineNumbers(code) {
    let lineno = 1;
    return code
      .split("\n")
      .map((line) => `/*${lineno++}*/ ${line}`)
      .join("\n");
  }

  let blurOnNextCancel = false;
  let editorText = "";
  function onEditorDone(
    text: string,
    cancelled: boolean = false,
    run: boolean = false
  ) {
    if (cancelled) {
      // just clear and return, also blur on double-cancel
      if (blurOnNextCancel) {
        setTimeout(() => textArea(-1).blur());
        blurOnNextCancel = false;
      } else blurOnNextCancel = true;
      lastEditorChangeTime = 0; // disable debounce even if editor focused
      onEditorChange((editorText = ""));
      return;
    }
    blurOnNextCancel = false;

    let editing = true; // created item can be editing or not
    let time = Date.now(); // default time is current, can be past if undeleting
    let origText = text;

    switch (text.trim()) {
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
      case "/dependencies": {
        if (editingItems.length == 0) {
          alert("/dependencies: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/dependencies: too many items selected");
          return;
        }
        let item = items[editingItems[0]];

        let deps = [];
        item.deps.map((id) => {
          const dep = items[indexFromId.get(id)];
          deps.push(dep.label || dep.id);
        });

        text = deps.join(" ");
        break;
      }
      case "/dependents": {
        if (editingItems.length == 0) {
          alert("/dependents: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/dependents: too many items selected");
          return;
        }
        let item = items[editingItems[0]];
        let deps = [];
        items.forEach((dep) => {
          if (dep.index == item.index) return; // skip self
          if (dep.deps.length > 1 && dep.deps.indexOf(item.id) >= 0) {
            if (dep.label && dep.labelUnique) deps.push(dep.label);
            else deps.push("id:" + dep.id);
          }
        });
        text = deps.join(" ");
        break;
      }
      case "/debug": {
        if (!lastRunText) {
          alert(`/debug: no runs (in this session)`);
          return;
        }
        text = "#debug " + lastRunText;
        editing = true;
        break;
      }
      case "/debug_eval": {
        if (!lastEvalText) {
          alert(`/debug: no _eval calls (in this session)`);
          return;
        }
        text = "#debug " + lastEvalText;
        editing = true;
        break;
      }
      case "/add_user": {
        let batch = firestore().batch();
        let collection = firestore().collection("items");
        items.forEach((item) => {
          let doc = collection.doc(item.savedId);
          batch.update(doc, { user: user.uid });
        });
        batch
          .commit()
          .then(() => {
            alert("done!");
          })
          .catch(console.error);
        return;
      }
      case "/init_history": {
        let added = 0;
        items.forEach((item) => {
          firestore()
            .collection("items-history")
            .add({
              item: item.id,
              user: user.uid,
              time: item.time,
              text: item.text,
            })
            .then((doc) => {
              console.debug(
                `"added ${++added} of ${items.length} items to items-history`
              );
            })
            .catch(console.error);
        });
        return;
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
          text =
            "```js_input\n" + text.replace(/\/js(\s|$)/s, "").trim() + "\n```";
        } else if (text.match(/^\/\w+/)) {
          let cmd = text.match(/^\/\w+/)[0];
          let args = text.replace(/^\/\w+\s*/, "").replace(/'/g, "\\'");
          if (idsFromLabel.has("#command" + cmd)) {
            try {
              window["_eval"](`run('${args}')`, "#command" + cmd);
            } catch (e) {
              alert("#command" + cmd + ": " + e);
              throw e;
            }
            return;
          } else {
            alert(`unknown command ${cmd}`);
            return;
          }
        } else if (text.match(/^\/\s+/s)) {
          text = text.replace(/^\/\s+/s, "");
        }
        // editing = text.trim().length == 0; // if text is empty, continue editing
      }
    }

    let itemToSave = {
      user: user.uid,
      time: time,
      text: text,
    };
    let item = {
      ...itemToSave,
      id: Date.now().toString(), // temporary id for this session only
      savedId: null, // filled in below after save
      editing: editing,
      // saving: true,
      saving: !editing,
      savedTime: time,
      savedText: "", // so cancel = delete
    };
    items = [item, ...items];
    // update indices as needed by itemTextChanged
    items.forEach((item, index) => indexFromId.set(item.id, index));
    itemTextChanged(0, text, false); // dependencies updated with permanent id below
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    // NOTE: we keep the starting tag if it is a non-unique label
    //       (useful for adding items, e.g. todo items, without losing context)
    editorText =
      items[0].label && !items[0].labelUnique ? items[0].label + " " : "";
    onEditorChange(editorText); // integrate new item at index 0
    // NOTE: if not editing, append JS output and trigger another layout if necessary
    if (!editing) {
      appendJSOutput(indexFromId.get(item.id));
      if (item.text != text) {
        itemToSave.text = item.text;
        // invoke onEditorChange again due to text change
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange(editorText);
      }
    }
    let textarea = textArea(-1);
    textarea.focus(); // refocus (necessary on iOS for shifting focus to another item)
    if (editing) {
      let selectionStart = textarea.selectionStart;
      let selectionEnd = textarea.selectionEnd;
      // for generated (vs typed) items, focus at the start for better context and no scrolling up
      // if (text != origText) selectionStart = selectionEnd = text.length;
      if (text != origText) selectionStart = selectionEnd = 0;
      setTimeout(() => {
        let textarea = textArea(indexFromId.get(item.id));
        textarea.selectionStart = selectionStart;
        textarea.selectionEnd = selectionEnd;
        textarea.focus();
      }, 0);
    }

    firestore()
      .collection("items")
      .add(itemToSave)
      .then((doc) => {
        let index = indexFromId.get(item.id); // since index can change
        item = items[index];
        if (index == undefined) {
          // item was deleted before it could be saved
          doc.delete().catch(console.error);
          return;
        }
        let textarea = textArea(index);
        let selectionStart = textarea ? textarea.selectionStart : 0;
        let selectionEnd = textarea ? textarea.selectionEnd : 0;
        item.savedId = doc.id;
        // if editing, we do not call onItemSaved so save is postponed to post-edit
        if (!item.editing) onItemSaved(item.id, itemToSave);
        else items[index] = item; // trigger dom update

        if (focusedItem == index)
          // maintain focus (and caret placement) through id/element change
          setTimeout(() => {
            let index = indexFromId.get(item.id);
            if (index == undefined) return;
            let textarea = textArea(index);
            if (!textarea) return;
            textarea.selectionStart = selectionStart;
            textarea.selectionEnd = selectionEnd;
            textarea.focus();
          }, 0);
        // also save to items-history (using persistent doc.id) ...
        firestore()
          .collection("items-history")
          .add({ item: doc.id, ...itemToSave })
          .catch(console.error);
      })
      .catch(console.error);
  }

  function focusOnNearestEditingItem(index: number) {
    // console.debug("focusOnNearestEditingItem", index, editingItems);
    let near = Math.min(
      ...editingItems.filter((i) => i > index && i < maxIndexToShow)
    );
    if (near == Infinity)
      near = Math.max(
        ...[-1, ...editingItems.filter((i) => i < maxIndexToShow)]
      );
    focusedItem = near;
    setTimeout(() => {
      textArea(near).focus();
      // console.debug("focused on item", near);
    }, 0);
  }

  function onItemSaved(id: string, savedItem) {
    const index = indexFromId.get(id);
    if (index == undefined) return; // item was deleted
    // console.debug("saved item", index);
    let item = items[index];
    item.savedText = savedItem.text;
    item.savedTime = savedItem.time;
    item.saving = false;
    items[index] = item; // trigger dom update
    if (item.saveClosure) {
      item.saveClosure(item.id);
      delete item.saveClosure;
    }
  }

  let layoutPending = false;
  function onItemResized(id, container, trigger: string) {
    if (!container) return;
    const index = indexFromId.get(id);
    if (index == undefined) return;
    let item = items[index];
    // exclude any ._log elements since they are usually collapsed
    let logHeight = 0;
    container
      .querySelectorAll("._log")
      .forEach((log) => (logHeight += log.offsetHeight));
    const height = container.offsetHeight - logHeight;
    const prevHeight = item.height;
    if (height == prevHeight) return; // nothing has changed
    // NOTE: on iOS, editing items can trigger zero height to be reported, which we ignore
    //       (seems to make sense generally since items should not have zero height)
    if (height == 0 && prevHeight > 0) {
      // console.warn(
      //   `zero height (last known height ${prevHeight}) for item ${id} at index ${index+1}`,
      //   item.text.substring(0, Math.min(item.text.length, 80))
      // );
      return;
    }

    // console.debug(
    //   `[${index + 1}] ${
    //     item.label ? item.label + ": " : ""
    //   } height changed ${prevHeight} → ${height} (${trigger})`
    // );
    item.height = height;

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

  const itemShowLogsTime = 15000;
  function itemShowLogs(id: string) {
    let index = indexFromId.get(id);
    if (index == undefined) return;
    items[index].showLogs = true;
    const dispatchTime = (items[index].showLogsTime = Date.now());
    setTimeout(() => {
      let index = indexFromId.get(id);
      if (index == undefined) return;
      if (dispatchTime == items[index].showLogsTime)
        items[index].showLogs = false;
    }, itemShowLogsTime);
  }

  function itemUpdateRunning(id: string, running: boolean) {
    let index = indexFromId.get(id);
    if (index == undefined) return;
    // console.debug("itemUpdateRunning", id, running);
    if (items[index].running != running) {
      items[index].running = running;
      if (running) items[index].runStartTime = Date.now();
      else itemShowLogs(id);
    }
    items[index] = items[index]; // trigger dom update
    return items[index].runStartTime;
  }

  let evalItemId;
  function evalJSInput(
    text: string,
    label: string = "",
    index: number
  ): string {
    let jsin = extractBlock(text, "js_input");
    if (jsin.length == 0) return "";
    let item = items[index];
    jsin = jsin.replace(/(^|[^\\])\$id/g, "$1" + item.id);
    jsin = jsin.replace(/(^|[^\\])\$hash/g, "$1" + item.hash);
    jsin = jsin.replace(/(^|[^\\])\$deephash/g, "$1" + item.deephash);
    //const evaljs = "(function(){\n" + jsin + "\n})()";
    const evaljs = jsin;
    if (lastRunText)
      lastRunText = appendBlock(
        lastRunText,
        "js_input",
        addLineNumbers(evaljs)
      );
    const start = Date.now();
    try {
      evalItemId = item.id;
      // NOTE: we do not set item.running for sync eval since dom state could not change, and since the eval could trigger an async chain that also sets item.running and would be disrupted if we set it to false here.
      let out = eval(evaljs);
      // ignore output if Promise
      if (out instanceof Promise) out = undefined;
      const outputConfirmLength = 16 * 1024;
      if (out && out.length >= outputConfirmLength) {
        if (
          !confirm(
            `Write ${out.length} bytes (js_output) into ${
              item.label || `item ${item.index + 1}`
            }?`
          )
        )
          out = undefined;
      }
      evalItemId = null;
      // automatically _write_log into item
      window["_write_log"](item.id, start);
      itemShowLogs(item.id);
      return out;
    } catch (e) {
      evalItemId = null;
      let msg = e.toString();
      if (label) msg = label + ": " + msg;
      if (console["_eval_error"]) console["_eval_error"](msg);
      else alert(msg);
      // automatically _write_log into item
      window["_write_log"](item.id, start);
      itemShowLogs(item.id);
      return undefined;
    }
  }

  function appendBlock(text: string, type: string, block) {
    if (typeof block != "string") block = "" + block;
    if (block.length > 0 && block[block.length - 1] != "\n") block += "\n";
    block = "\n```" + type + "\n" + block + "```";
    const empty = "\n```" + type + "\n```";
    const regex = "(?:^|\\n) *```" + type + "\\n.*?\\s*```";
    if (text.match(RegExp(regex, "s"))) {
      let count = 0;
      text = text.replace(RegExp(regex, "gs"), () =>
        count++ == 0 ? block : empty
      );
    } else {
      text += block;
    }
    return text;
  }

  let lastRunTime = 0;
  function appendJSOutput(index: number): string {
    let item = items[index];
    // eval js_input blocks
    if (item.text.match(/\s*```js_input\s/)) {
      lastRunTime = Date.now(); // used in _write_log, see below
      lastRunText = item.text;
      // execute JS code, including any 'js' blocks from this and any tag-referenced items
      // NOTE: js_input blocks are assumed "local", i.e. not intended for export
      let prefix = window["_read_deep"]("js", item.id, { replace_$id: true });
      if (prefix) prefix = "```js_input\n" + prefix + "\n```\n";
      if (item.debug) prefix = ""; // debug items are self-contained
      item.text = item.text.replace(
        /(?:^|\n) *```js_output\n(?: *```|.*?\n *```)/gs,
        ""
      );
      let jsout = evalJSInput(prefix + item.text, item.label, index) || "";
      if (jsout) item.text = appendBlock(item.text, "js_output", jsout);
    }
    return item.text;
  }

  function saveItem(id: string) {
    // console.debug("saving item", id);
    const index = indexFromId.get(id);
    if (index == undefined) return; // item deleted
    let item = items[index];
    // if item is already saving, set saveClosure and return (no need to chain)
    if (item.saving) {
      item.saveClosure = saveItem;
      return;
    }
    item.saving = true;
    let itemToSave = {
      time: item.time,
      text: item.text,
    };
    // do not save any _tmp blocks
    itemToSave.text = item.text.replace(
      /(?:^|\n) *```(\w*?_tmp)\n.*?\s*```/gs,
      ""
    );
    // trigger itemTextChanged only if savedText is different (not just for time change)
    if (itemToSave.text != item.savedText)
      itemTextChanged(index, itemToSave.text);
    firestore()
      .collection("items")
      .doc(item.savedId)
      .update(itemToSave)
      .then(() => {
        onItemSaved(item.id, itemToSave);
      })
      .catch(console.error);
    // also save to items-history ...
    firestore()
      .collection("items-history")
      .add({ user: user.uid, item: item.savedId, ...itemToSave })
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

  function onItemEditing(
    index: number,
    editing: boolean,
    cancelled: boolean = false,
    run: boolean = false
  ) {
    let item = items[index];

    // if cancelled, restore savedTime and savedText (unless empty)
    if (cancelled) {
      item.time = item.savedTime;
      if (item.text) item.text = item.savedText;
    } else if (!item.log) {
      // update time for non-log item
      item.time = Date.now();
    }

    // remove _tmp blocks whenever editing state changes
    item.text = item.text.replace(/(?:^|\n) *```(\w*?_tmp)\n.*?\s*```/gs, "");

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
      }, 0); // trigger resort
    } else {
      // stopped editing
      editingItems.splice(editingItems.indexOf(index), 1);
      // NOTE: onItemFocused may not get invoked (and item.focused may remain true) on destroyed editors
      if (focusedItem == index) {
        focusedItem = -1;
        item.focused = false;
      }
      if (item.text.trim().length == 0) {
        // delete
        itemTextChanged(index, ""); // clears label, deps, etc
        items.splice(index, 1);
        // updateItemLayout();
        onEditorChange(editorText); // deletion can affect ordering (e.g. due to missingTags)
        deletedItems.unshift({
          time: item.savedTime,
          text: item.savedText,
        }); // for /undelete
        firestore()
          .collection("items")
          .doc(item.savedId)
          .delete()
          .catch(console.error);
      } else {
        // // clear _output and execute javascript unless cancelled
        if (run && !cancelled) {
          // empty out any *_output|*_log blocks as they should be re-generated
          item.text = item.text.replace(
            /(^|\n) *```(\w*?_output)\n(?: *```|.*?\n *```) *(\n|$)/gs,
            "$1```$2\n```$3"
          );
          item.text = item.text.replace(
            /(^|\n) *```(\w*?_log)\n(?: *```|.*?\n *```) *(\n|$)/gs,
            "$3" // remove so errors do not leave empty blocks
          );
          itemTextChanged(index, item.text); // updates tags, label, deps, etc before JS eval
          appendJSOutput(index);
        }
        // save edit state for resuming edit
        if (!cancelled) {
          let textarea = textArea(item.index);
          lastEditItem = item.id;
          lastEditPosition = textarea.selectionStart;
        }
        if (item.time != item.savedTime || item.text != item.savedText)
          saveItem(item.id);
        onEditorChange(editorText); // item time and/or text has changed
      }

      // NOTE: we do not focus back up on the editor unless we are already at the top
      //       (especially bad on iphone due to lack of keyboard focus benefit)
      if (editingItems.length > 0 || window.scrollY == 0) {
        focusOnNearestEditingItem(index);
      } else {
        // scroll up if needed, allowing dom update before calculating new position
        // (particularly important for items that are much taller when editing)
        setTimeout(() => {
          const div = document.querySelector("#super-container-" + item.id);
          if (!div) return; // item deleted or hidden
          const itemTop = (div as HTMLElement).offsetTop;
          if (itemTop < window.scrollY) {
            // console.debug("scrolling up", itemTop, window.scrollY);
            window.top.scrollTo(0, itemTop);
          }
        });
      }
    }

    // console.debug(`item ${index} editing: ${editing}, editingItems:${editingItems}, focusedItem:${focusedItem}`);
  }

  // WARNING: onItemFocused may NOT be invoked when editor is destroyed
  function onItemFocused(index: number, focused: boolean) {
    if (focused) focusedItem = index;
    else focusedItem = -1;
    // console.debug(
    //   `item ${index} focused: ${focused}, focusedItem:${focusedItem}`
    // );
  }

  function onItemRun(index: number = -1) {
    if (index < 0) index = focusedItem;
    let item = items[index];
    // empty out any *_output|*_log blocks as they should be re-generated
    item.text = item.text.replace(
      /(^|\n) *```(\w*?_output)\n(?: *```|.*?\n *```) *(\n|$)/gs,
      "$1```$2\n```$3"
    );
    item.text = item.text.replace(
      /(^|\n) *```(\w*?_log)\n(?: *```|.*?\n *```) *(\n|$)/gs,
      "$3" // remove so errors do not leave empty blocks
    );
    itemTextChanged(index, item.text); // updates tags, label, deps, etc before JS eval
    appendJSOutput(index);
    item.time = Date.now();
    if (!item.editing) saveItem(item.id);
    editorBlurTime = 0; // prevent re-focus on editor
    onEditorChange(editorText); // item time/text has changed
  }

  function onItemTouch(index: number) {
    items[index].time = Date.now();
    saveItem(items[index].id);
    editorBlurTime = 0; // prevent re-focus on editor
    onEditorChange(editorText); // item time has changed
  }

  function editItem(index: number) {
    items[index].editing = true;
    editingItems.push(index);
  }

  let lastEditItem;
  let lastEditPosition;
  function resumeLastEdit() {
    if (!lastEditItem) return;
    let index = indexFromId.get(lastEditItem);
    if (index == undefined) return;
    if (index >= maxIndexToShow) return;
    if (items[index].editing) return;
    editItem(index);
    lastEditorChangeTime = 0; // force immediate update
    onEditorChange(editorText); // since edit state changed
    setTimeout(() => {
      textArea(index).focus();
      textArea(index).selectionStart = lastEditPosition;
    });
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
    if (focusedItem + inc >= Math.min(maxIndexToShow, items.length)) return;
    const index = focusedItem;
    const textarea = textArea(index);
    if (!items[index + inc].editing) {
      if (
        items[index + inc].pinned ||
        items[index + inc].saving ||
        items[index + inc].running
      ) {
        onNextItem(inc + 1);
        return;
      } // skip if pinned, saving, or running
      editItem(index + inc);
    }
    setTimeout(() => textArea(index + inc).focus(), 0);
  }

  function updateDotted() {
    if (!consolediv) return; // can happen during login process
    // auto-hide dotted items (and console) when empty
    if (dotCount == 0) showDotted = false;
    // force show dotted items when any of them are editing
    if (editingItems.findIndex((i) => items[i].dotted) >= 0) showDotted = true;
    (document.querySelector("span.dots") as HTMLElement).style.opacity = "1";
    (document.querySelector(
      "span.dots"
    ) as HTMLElement).style.visibility = showDotted ? "hidden" : "visible";
    document.querySelectorAll(".dotted").forEach((dotted) => {
      (dotted as HTMLElement).style.display = showDotted ? "block" : "none";
    });
  }

  let lastScrollTime = 0;
  let lastScrolledDownTime = 0;
  let scrollToggleLocked = false; // prevent repeated toggle
  let showDotted = false;
  let showDottedPending = false;
  function onScroll() {
    lastScrollTime = Date.now();
    return; // pull menu disabled for now, not as useful due to forced wait until end of bounce animation, and triggered accidentally many times on iPhone and iPad
    if (window.scrollY > 0) lastScrolledDownTime = lastScrollTime;
    if (window.scrollY == 0) lastScrolledDownTime = 0;
    if (
      window.scrollY <= -100 &&
      !scrollToggleLocked &&
      Date.now() - lastScrolledDownTime > 1000
    ) {
      scrollToggleLocked = true;
      showDotted = !showDotted;
      // NOTE: display:none on any elements (even spans) while bouncing breaks the bounce animation on iOS
      // (playing around with visibility/height/position/etc did not work either)
      showDottedPending = true;
      (document.querySelector("span.dots") as HTMLElement).style.visibility =
        "visible";
      (document.querySelector("span.dots") as HTMLElement).style.opacity =
        "0.5";
      // attempt focus on editor (may not work on iOS)
      // document.getElementById("textarea-editor").focus();
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

  function onConsoleClick(e) {
    // ignore click if text is selected
    if (window.getSelection().type == "Range") {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    consolediv.style.display = "none";
    document.getElementById("console-summary").style.visibility = "visible";
  }
  function onConsoleSummaryClick(e) {
    if (consolediv.childNodes.length > 0) {
      e.stopPropagation();
      consolediv.style.display = "block";
      document.getElementById("console-summary").style.visibility = "hidden";
    }
  }

  function errorMessage(e) {
    // NOTE: for UnhandledPromiseRejection, Event object is placed in e.reason
    if (
      !e.message &&
      (e.type == "error" || (e.reason && e.reason.type == "error"))
    ) {
      if (e.reason) e = e.reason;
      let url =
        e.target && (e.target["url"] || e.target["src"])
          ? e.target["url"] || e.target["src"]
          : "(unknown url)";
      return `error loading ${url}`;
    }
    return e.reason
      ? `Unhandled Rejection: ${e.reason} (line:${e.reason.line}, col:${e.reason.column})`
      : e.message
      ? `${e.message} (line:${e.lineno}, col:${e.colno})`
      : undefined;
  }

  import { onMount } from "svelte";
  import {
    hashCode,
    numberWithCommas,
    extractBlock,
    parseTags,
  } from "../util.js";

  let consoleLog = [];
  const consoleLogMaxSize = 10000;
  const statusLogExpiration = 15000;

  if (isClient) {
    // initialize item state
    indexFromId = new Map<string, number>(); // needed for initial itemTextChanged
    items.forEach((item, index) => indexFromId.set(item.id, index));
    items.forEach((item, index) => {
      itemTextChanged(index, item.text, false); // deps handled below after index assignment
      item.savedId = item.id;
      item.savedText = item.text;
      item.savedTime = item.time;
      // NOTE: we also initialized other state here to have a central listing
      // state used in onEditorChange
      item.labelMatch = false;
      item.tagMatch = false;
      item.prefixMatch = false;
      item.pinnedMatch = false;
      item.pinnedMatchTerm = "";
      item.matchingTerms = [];
      item.matchingTermsSecondary = [];
      item.missingTags = [];
      item.hasError = false;
      // state from updateItemLayout
      item.index = index;
      item.timeString = "";
      item.timeOutOfOrder = false;
      item.height = 0;
      item.column = 0;
      item.nextColumn = -1;
      item.nextItemInColumn = -1;
      item.outerHeight = 0;
    });
    onEditorChange(""); // initial sorting
    items.forEach((item, index) => {
      // initialize deps, deephash, missing tags/labels
      item.deps = itemDeps(index);
      item.deephash = hashCode(
        item.deps.map((id) => items[indexFromId.get(id)].hash).join()
      );
    });

    // Sign in user as needed ...
    if (error) console.error(error); // log server-side error
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
            const levels = [
              "debug",
              "info",
              "log",
              "warn",
              "error",
              "_window_error",
              "_eval_error",
            ];
            levels.forEach(function (verb) {
              console[verb] = (function (method, verb, div) {
                return function (...args) {
                  method(...args);
                  var elem = document.createElement("div");
                  if (verb.endsWith("error")) verb = "error";
                  elem.classList.add("console-" + verb);
                  let item; // if the source is an item (and the logging is done _synchronously_)
                  if (
                    window["_script_item_id"] &&
                    indexFromId.has(window["_script_item_id"])
                  ) {
                    item = items[indexFromId.get(window["_script_item_id"])];
                  } else if (evalItemId) {
                    item = items[indexFromId.get(evalItemId)];
                  }
                  if (item) {
                    // prepent item index, label (if any)
                    if (item.label) args.unshift(item.label + ":");
                    args.unshift(`[${item.index + 1}]`);
                  }
                  // log url for "error" Events that do not have message/reason
                  // see https://www.w3schools.com/jsref/event_onerror.asp
                  if (args.length == 1 && errorMessage(args[0])) {
                    elem.textContent = errorMessage(args[0]);
                  } else {
                    elem.textContent = args.join(" ") + "\n";
                  }
                  elem.setAttribute("_time", Date.now().toString());
                  elem.setAttribute("_level", levels.indexOf(verb).toString());
                  div.appendChild(elem);
                  consoleLog.push({
                    type: verb,
                    text: elem.textContent.trim(),
                    time: Date.now(),
                    level: levels.indexOf(verb),
                  });
                  if (consoleLog.length > consoleLogMaxSize)
                    consoleLog = consoleLog.slice(consoleLogMaxSize / 2);

                  document.getElementById(
                    "console-summary"
                  ).style.visibility = showDotted ? "hidden" : "visible";
                  const summaryDiv = document.getElementById("console-summary");
                  const summaryElem = document.createElement("span");
                  summaryElem.innerText = "·";
                  summaryElem.classList.add("console-" + verb);
                  summaryDiv.appendChild(summaryElem);

                  // if console is hidden, make sure summary is visible
                  if (div.style.display == "none")
                    summaryDiv.style.visibility = "visible";

                  // auto-remove after 15 seconds ...
                  setTimeout(() => {
                    elem.remove();
                    summaryElem.remove();
                    if (div.childNodes.length == 0) {
                      div.style.display = "none";
                      summaryDiv.style.visibility = "visible";
                    }
                  }, statusLogExpiration);
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
                // console.debug("updated cookie", error || "(no error)");
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

    function indicesForItem(item: string) {
      if (item == "auto" || item == "self" || item == "this") item = "";
      if (!item && evalItemId) {
        return [indexFromId.get(evalItemId)];
      } else if (
        !item &&
        window["_script_item_id"] &&
        indexFromId.has(window["_script_item_id"])
      ) {
        return [indexFromId.get(window["_script_item_id"])];
      } else if (indexFromId.has(item)) {
        return [indexFromId.get(item)];
      } else {
        // NOTE: for multiple items, ordering is by label, empty labels come first, and ordering is arbitrary within labels
        return _.sortBy(
          (idsFromLabel.get(item) || []).map((id) => indexFromId.get(id)),
          (index) => items[index].label
        );
      }
    }

    window["_id"] = function (item: string = "", multiple: boolean = false) {
      let ids = [];
      let indices = indicesForItem(item);
      if (!item && indices.length == 0) {
        console.error("_id() invoked from async javascript or macro");
        return null;
      }
      indices.map((index) => {
        ids.push(items[index].id);
      });
      if (multiple) return ids; // return as array
      if (ids.length > 1)
        console.warn(`multiple items matched _id(${item}), returning first`);
      return ids[0];
    };
    window["_ids"] = function (item: string = "") {
      return window["_id"](item, true /* multiple */);
    };

    window["_label"] = function (item: string = "", multiple: boolean = false) {
      let labels = [];
      let indices = indicesForItem(item);
      if (!item && indices.length == 0) {
        console.error("_label() invoked from async javascript or macro");
        return null;
      }
      indices.map((index) => {
        labels.push(items[index].label);
      });
      if (multiple) return labels; // return as array
      if (labels.length > 1)
        console.warn(`multiple items matched _label(${item}), returning first`);
      return labels[0];
    };
    window["_labels"] = function (item: string = "") {
      return window["_label"](item, true /* multiple */);
    };

    window["_tags"] = function (item: string = "") {
      let tags = [];
      let indices = indicesForItem(item);
      indices.map((index) => {
        tags = tags.concat(parseTags(items[index].text.toLowerCase()).all);
      });
      return tags;
    };

    window["_read"] = function (
      type: string = "",
      item: string = "",
      options: object = {}
    ) {
      let content = [];
      let indices = indicesForItem(item);
      indices.map((index) => {
        let item = items[index];
        if (type == "js" || type == "webppl")
          content.push(`/* ${type} @ ${item.label || "id:" + item.id} */`);
        else if (type == "html")
          content.push(`<!-- ${type} @ ${item.label || "id:" + item.id} -->`);
        // NOTE: by convention, dependencies are included _before_ item itself
        if (options["include_deps"]) {
          options["include_deps"] = false; // deps are recursive already
          item.deps
            .filter((id) => id != item.id)
            .forEach((id) =>
              content.push(
                window["_read"](options["dep_type"] || type, id, options)
              )
            );
        }
        let text = type ? extractBlock(item.text, type) : item.text;
        if (options["replace_$id"])
          text = text.replace(/(^|[^\\])\$id/g, "$1" + item.id);
        content.push(text);
      });
      return content.filter((s) => s).join("\n");
    };

    window["_read_deep"] = function (
      type: string = "",
      item: string = "",
      options: object = {}
    ) {
      return window["_read"](
        type,
        item,
        Object.assign({ include_deps: true }, options)
      );
    };
    window["_eval"] = function (
      code: string = "",
      item: string = "",
      options: object = {}
    ) {
      let prefix = window["_read_deep"](
        "js",
        item,
        Object.assign({ include_deps: true, replace_$id: true }, options)
      );
      let evaljs = prefix + "\n" + code;
      const index = indicesForItem("")[0]; // index of invoking item (_id()) or undefined
      lastEvalText = appendBlock(
        index != undefined
          ? `\`_eval\` invoked from ${
              items[index].label || "id:" + items[index].id
            }`
          : "",
        "js_input",
        addLineNumbers(evaljs)
      );
      return eval(evaljs);
    };

    window["_write"] = function (
      item: string,
      text: string,
      type: string = "_output"
    ) {
      let ids = indicesForItem(item).map((index) => items[index].id);
      if (ids.length == 0) {
        console.error(`could not determine item(s) for _write to '${item}'`);
        return;
      }
      let indices = ids.map((id) => indexFromId.get(id));
      indices.map((index) => {
        if (index == undefined) return; // deleted
        let item = items[index];
        // confirm if write is too big
        const writeConfirmLength = 16 * 1024;
        if (text && text.length >= writeConfirmLength) {
          if (
            !confirm(
              `Write ${text.length} bytes (${type}) into ${
                item.label || `item ${item.index + 1}`
              }?`
            )
          )
            return; // cancel write
        }
        // if writing *_log, clear any existing *_log blocks
        // (and skip write if block is empty)
        if (type.endsWith("_log")) {
          item.text = item.text.replace(
            /(^|\n) *```(\w*?_log)\n(?: *```|.*?\n *```) *(\n|$)/gs,
            "$3"
          );
          if (text) item.text = appendBlock(item.text, type, text);
        } else {
          if (type == "") item.text = text;
          else item.text = appendBlock(item.text, type, text);
        }
        item.time = Date.now();
        onEditorChange(editorText); // item time/text has changed
        if (type.endsWith("_tmp")) return; // do not save _tmp blocks
        saveItem(item.id);
      });
    };

    // default level (1) excludes debug messages, and default since (-1) is lastRunTime
    // NOTE: default since=lastRunTime is only accurate if _read_log is invoked synchronously
    window["_read_log"] = function (since: number = -1, level: number = 1) {
      let log = [];
      if (since < 0) since = lastRunTime;
      for (let i = consoleLog.length - 1; i >= 0; --i) {
        const entry = consoleLog[i];
        if (entry.time < since) break;
        if (entry.level < level) continue;
        let prefix = entry.type == "log" ? "" : entry.type.toUpperCase() + ": ";
        if (prefix == "WARN: ") prefix = "WARNING: ";
        // remove item index/label prefix since redundant (assuming writing to item itself)
        const text = entry.text
          .replace(/^\[\d+?\]\s*/, "")
          .replace(/^#.+?:\s*/, "");
        log.push(prefix + text);
      }
      log = log.reverse();
      return log.join("\n");
    };

    window["_write_log"] = function (
      item: string,
      since: number = -1,
      level: number = 1,
      type: string = "_log"
    ) {
      const log = window["_read_log"](since, level);
      window["_write"](item, log, type);
    };

    window["_task"] = function (
      interval: number,
      task: Function,
      item: string = ""
    ) {
      let indices = indicesForItem(item);
      if (!window["_tasks"]) window["_tasks"] = {};
      indices.map((index) => {
        // clear any previous tasks for item under id
        clearInterval(window["_tasks"][items[index].id]);
        delete window["_tasks"][items[index].id];
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
        axis: {
          x: {
            show: true,
            tick: { outer: false, multiline: false },
            padding: 0,
          },
          y: {
            show: !labeled,
            tick: { outer: false, multiline: false },
            padding: {
              bottom: 10,
              top: rotated && labeled ? 70 : labeled ? 40 : 10,
            },
          },
        },
        grid: { focus: { show: !barchart } },
        legend: { show: false },
      };
      if (rotated) defaults["padding"] = { bottom: 7 };
      spec = _.merge(defaults, spec);
      document.querySelectorAll(selector).forEach((elem) => {
        if (labeled) elem.classList.add("c3-labeled");
        if (rotated) elem.classList.add("c3-rotated");
        if (barchart) elem.classList.add("c3-barchart");
      });
      const chart = window["c3"].generate(spec);
      document.querySelectorAll(selector).forEach((elem) => {
        if (spec["size"] && spec["size"]["height"])
          (elem as HTMLElement).style.height = spec["size"]["height"] + "px";
        elem["_chart"] = chart;
      });
      return chart;
    };

    // wrapper for d3 graphviz
    window["_dot"] = function (selector: string, dot: string) {
      // NOTE: best way to define defaults seems to be by inserting attributes into the dot, which are turned into SVG attributes by d3 graphviz, which take lowest priority (as opposed to inline styles which would take highest, see https://stackoverflow.com/a/24294284) and can be easily modified either in the dot code or using CSS
      const nodedefs =
        'color="#999999",fontcolor="#999999",fontname="Avenir Next, Helvetica",fontsize=20,shape=circle,fixedsize=true';
      const edgedefs =
        'color="#999999",fontcolor="#999999",fontname="Avenir Next, Helvetica",penwidth=1';
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
      let weights;
      // if numbers is a distribution, extract samples or distribution
      if (numbers["samples"]) {
        let samples = numbers["samples"];
        numbers = samples.map((s) => s["value"]);
        weights = new Array(numbers.length).fill(1);
        // weights = samples.map((s) => Math.exp(s["score"]));
        // let sum = weights.reduce((a, b) => a + b, 0);
        // weights = weights.map((w) => w / sum);
      } else if (numbers["getDist"]) {
        let dist = numbers["getDist"]();
        numbers = Object.keys(dist).map(parseFloat);
        weights = Object.values(dist).map((v) => v["prob"]);
      } else {
        // assume unit weights to display counts
        weights = new Array(numbers.length).fill(1);
      }
      if (min > max) {
        // determine range using data
        numbers.forEach((num) => {
          if (num < min) min = num;
          else if (num > max) max = num;
        });
      }
      const size = (max - min) / bins;
      const counts = new Array(bins).fill(0);
      numbers.forEach((num, index) => {
        if (num < min || num > max) return;
        counts[num == max ? bins - 1 : Math.floor((num - min) / size)] +=
          weights[index];
      });
      let histogram = {};
      const sample_max = Math.max(...numbers);
      counts.forEach((count, index) => {
        const lower = (min + index * size).toFixed(digits);
        const upper =
          index == bins - 1
            ? max.toFixed(digits)
            : (min + (index + 1) * size).toFixed(digits);
        let key =
          `[${lower}, ${upper}` +
          (index == bins - 1 && sample_max == max ? "]" : ")");
        if (
          key[key.length - 1] == ")" &&
          Number.isInteger(parseFloat(lower)) &&
          parseFloat(upper) == parseInt(lower) + 1
        ) {
          key = parseInt(lower).toString();
        }
        histogram[key] = count > 0 ? count.toFixed(2) : 0;
      });
      return histogram;
    };

    window["_compare_histograms"] = function (
      numbers: any,
      baseline: any,
      bins: number = 10,
      min: number = Infinity,
      max: number = -Infinity,
      digits: number = 2
    ) {
      if (min > max) {
        numbers.concat(baseline).forEach((num) => {
          if (num < min) min = num;
          else if (num > max) max = num;
        });
      }
      const hist1 = window["_histogram"](numbers, bins, min, max, digits);
      const hist2 = window["_histogram"](baseline, bins, min, max, digits);
      return {
        keys: _.keys(hist1),
        values: window["_normalize"](_.values(hist1)),
        baseline: window["_normalize"](_.values(hist2)),
      };
    };

    window["_normalize"] = function (numbers: any, digits: number = 3) {
      const sum = _.sum(numbers.map(parseFloat));
      return numbers.map((x) => (parseFloat(x) / sum).toFixed(digits));
    };

    window["_samples"] = function (dist: any) {
      return dist.samples.map((s) => s["value"]);
    };

    // NOTE: this sorts by decreasing counts unless keys are integers or specified as array
    window["_counts"] = function (list, range: any = 10) {
      let counts = {};
      list.forEach((x) => {
        if (typeof x != "string") x = JSON.stringify(x);
        counts[x] = (counts[x] || 0) + 1;
      });
      if (typeof range == "object") {
        let out = {};
        range.forEach((k) => (out[k] = counts[k] || 0));
        return out;
      }
      let keys = Object.keys(counts);
      let values = Object.values(counts) as Array<number>;
      let indices = _.range(values.length);
      indices = stableSort(indices, (i, j) => values[j] - values[i]);
      indices = indices.filter((i) => values[i] > 0);
      indices.length = Math.min(indices.length, range);
      let out = {};
      indices.forEach((i) => (out[keys[i]] = values[i]));
      return out;
    };

    window["_pmf"] = function (
      dist,
      limit: number = 10,
      digits: number = 2,
      keydigits: number = 2
    ) {
      dist = dist.getDist();
      let keys = Object.keys(dist).map((k) => k.toString());
      let probs = Object.values(dist).map((v) => v["prob"]);
      let indices = _.range(probs.length);
      indices = stableSort(indices, (i, j) => probs[j] - probs[i]);
      if (keydigits >= 0 && keys.length > 0 && parseFloat(keys[0])) {
        keys = keys.map((k) => parseFloat(k).toFixed(keydigits));
        let pmf = {};
        indices.forEach((i) => (pmf[keys[i]] = (pmf[keys[i]] || 0) + probs[i]));
        keys = Object.keys(pmf);
        probs = Object.values(pmf);
        indices = _.range(probs.length);
        indices = stableSort(indices, (i, j) => probs[j] - probs[i]);
      }
      if (digits >= 0) probs = probs.map((v) => v.toFixed(digits));
      indices = indices.filter((i) => probs[i] > 0);
      indices.length = Math.min(indices.length, limit);
      let pmf = {};
      indices.forEach((i) => (pmf[keys[i]] = probs[i]));
      return pmf;
    };

    // NOTE: all errors are logged, so rejection handling is unnecessary for logging purposes
    // NOTE: resolve/reject handlers are async, e.g. must do their own _write_log if needed
    window["_run_webppl"] = function (id: string = "", options: object = {}) {
      let prevRunClosure = window["webppl"].runClosure;
      window["webppl"].runClosure = null; // chained into this one
      let webppl_done = () => {
        // dispatch closure to allow synchronous part of resolution chain to run first
        // (this is useful e.g. to write a final expanded _log in callbacks)
        setTimeout(() => {
          window["webppl"].running = false;
          if (prevRunClosure) prevRunClosure();
          else if (window["webppl"].runClosure) {
            window["webppl"].runClosure();
            window["webppl"].runClosure = null;
          }
        }, 0);
      };
      return new Promise((resolve, reject) => {
        if (!id) {
          if (!evalItemId) {
            const err = new Error(
              "_run_webppl: invoked from async javascript or macro"
            );
            console.error(err); // synchronous error that should get written into item
            reject(err);
            return;
          }
          id = evalItemId;
        }
        let item = items[indexFromId.get(id)];
        if (!item) {
          const err = new Error(`_run_webppl: item id:${id} not found`);
          console.error(err); // synchronous error that should get written into item
          reject(err);
          return;
        }

        // NOTE: similar to js_input (vs js), webppl_input blocks are treated as local execution blocks whereas webppl blocks are imported to construct possible prefix
        let webppl = window["_read"]("webppl_input", id);
        if (!webppl) {
          const err = new Error(`_run_webppl: missing webppl_input`);
          console.error(err); // synchronous error that should get written into item
          reject(err);
          return;
        }
        let webppl_prefix = window["_read_deep"]("webppl", id, {
          replace_$id: true,
        });

        itemUpdateRunning(id, true);

        let runClosure = function () {
          // NOTE: prevRunClosure must be run in webppl_done() call to ensure single-threading
          // if (prevRunClosure) prevRunClosure();
          let start = Date.now();
          window["webppl"].running = true;
          webppl = webppl_prefix + "\n" + webppl;
          if (lastRunText)
            lastRunText = appendBlock(
              lastRunText,
              "webppl_input",
              addLineNumbers(webppl)
            );
          try {
            window["webppl"].run(
              webppl,
              function (s, x) {
                let time = Date.now() - start;
                if (x != undefined) window["_write"](id, JSON.stringify(x));
                if (Object.keys(s).length > 0)
                  console.log("webppl state:", JSON.stringify(s));
                console.log("webppl took", time, "ms");
                window["_write_log"](id, start, 1);
                itemUpdateRunning(id, false);
                resolve({ output: x, start_time: start });
              },
              _.merge(
                {
                  verbose: false,
                  debug: false,
                  errorHandlers: [
                    function (e) {
                      console.error(`webppl error: ${e}`); // so error included in _write_log
                      window["_write_log"](id, start, 1);
                      itemUpdateRunning(id, false);
                      reject(new Error(`webppl error: ${e}`));
                    },
                  ],
                },
                options
              )
            );
          } catch (e) {
            console.error(`webppl exception: ${e}`);
            window["_write_log"](id, start, 1);
            itemUpdateRunning(id, false);
            reject(e);
            throw e;
          }
        };
        if (window["webppl"].running) {
          window["webppl"].runClosure = runClosure;
        } else {
          runClosure();
        }
      }).finally(webppl_done);
    };

    window["_running"] = function (id: string = "", running: boolean = true) {
      if (!id) {
        if (!evalItemId) {
          console.error("_running() invoked from async javascript or macro");
          return;
        }
        id = evalItemId;
      }
      return itemUpdateRunning(id, running);
    };

    window["_done"] = function (
      id: string,
      log_type: string = "_log",
      log_level: number = 1
    ) {
      const runStartTime = window["_running"](id, false);
      if (log_type) window["_write_log"](id, runStartTime, log_level, log_type);
      return runStartTime;
    };

    window["_array"] = function (length: number, func) {
      let array = new Array(length);
      for (let i = 0; i < length; ++i) array[i] = func(i);
      return array;
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
          console.log(
            `document width changed from ${lastDocumentWidth} to ${documentWidth}`
          );
          updateItemLayout();
          // also trigger resize of all charts on the page ...
          document.querySelectorAll(".c3").forEach((div) => {
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
    // console.debug(e);

    // resume-edit items on Shift-(save shortcut)
    if (
      (e.code == "KeyS" && (e.metaKey || e.ctrlKey) && e.shiftKey) ||
      (e.code == "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey)
    ) {
      e.preventDefault();
      resumeLastEdit();
      return;
    }

    // disable item editor shortcuts on window, focus on editor instead
    if (focusedItem >= 0) return; // already focused on an item
    if (
      (e.code == "Enter" &&
        (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
      (e.code == "KeyS" && (e.metaKey || e.ctrlKey)) ||
      ((e.code == "BracketLeft" || e.code == "BracketRight") && e.ctrlKey) ||
      (e.code == "Slash" && e.ctrlKey) ||
      e.code == "Tab" ||
      e.code == "Escape"
    ) {
      e.preventDefault();
      textArea(-1).focus();
      window.top.scrollTo(0, 0);
    }
  }

  // redirect error to alert or console._window_error if it exists
  function onError(e) {
    if (!consolediv) return; // can happen during login process
    // NOTE: if this is from onunhandledrejection, then we need to use e.reason
    let msg = errorMessage(e);
    if (console["_window_error"]) console["_window_error"](msg);
    else alert(msg);
    if (!window["_errors"]) window["_errors"] = [];
    window["_errors"].push(e);
  }
</script>

<style>
  #loading {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    width: 100%;
    height: 100%;
    min-height: -webkit-fill-available; /*consider bottom bar on iOS Safari*/
    justify-content: center;
    align-items: center;
    /* background: url(/loading.gif) no-repeat center; */
    /* background-size: 200px; */
  }
  #header {
    max-width: 100%;
  }
  #header-container {
    display: flex;
    padding: 4px 0;
    background: #111; /* matches unfocused editor */
    border-radius: 0 0 4px 4px;
  }
  #header-container.focused {
    background: #111;
  }
  #editor {
    margin-right: 4px;
    width: 100%;
  }
  /* remove dashed border when top editor is unfocused */
  :global(#header #editor .backdrop:not(.focused)) {
    border: 1px solid transparent;
  }
  /* lighten up border when focused */
  /* :global(#header #editor .backdrop.focused) {
    border: 1px solid #383838;
  } */
  .spacer {
    flex-grow: 1;
  }
  #user {
    height: 44px; /* must match height of single-line editor (also see @media query below) */
    margin-right: 4px;
    border-radius: 50%;
    background: gray;
    cursor: pointer;
  }
  #console {
    display: none;
    position: absolute;
    min-height: 20px; /* covers #console-summary (w/ +8px padding) */
    min-width: 60px; /* covers #console-summary */
    top: 0;
    left: 0;
    z-index: 10;
    padding: 4px;
    color: #999;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 4px;
    border: 1px solid #222;
    font-family: monospace;
    /* pointer-events: none; */
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
    height: 20px;
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
    top: 0;
    padding-top: 4px;
    height: 24px; /* matches #status height(+padding) above */
    min-width: 60px; /* ensure clickability */
    max-width: 30%; /* try not to cover center (item dots) */
    text-align: left;
    overflow: hidden;
    padding-left: 4px;
  }
  #status .counts {
    font-family: Avenir Next, Helvetica;
    position: absolute;
    right: 0;
    top: 0;
    padding-right: 4px; /* matches .corner inset on first item */
    padding-top: 4px;
  }
  :global(#status .counts .unit, #status .counts .comma) {
    color: #666;
    font-size: 80%;
  }
  #status .counts .matching {
    color: #9f9;
  }

  .items {
    width: 100%;
    display: flex;
    /* prevent horizontal overflow which causes stuck zoom-out on iOS Safari */
    /* (note that overflow-x did not work but this is fine too) */
    overflow: hidden;
  }
  .column {
    flex: 1;
    /* NOTE: BOTH min/max width are necessary to get proper flexing behavior */
    min-width: 0px;
    max-width: 750px;
  }
  .column:not(:last-child) {
    padding-right: 8px;
  }
  .section-separator {
    height: 33px; /* 4 full dashes on left border, 40px offsetHeigt is assumed during layout */
    margin-top: 2px;
    margin-bottom: 5px;
    padding-top: 7px;
    color: #444; /* same as time indicators */
    font-size: 16px;
    font-family: Avenir Next, Helvetica;
    text-align: center;
  }
  .section-separator .arrows {
    font-family: monospace;
    font-size: 20px;
  }
  .section-separator hr {
    display: inline-block;
    vertical-align: middle;
    background: transparent;
    border: 0;
    border-top: 2px solid #444;
    height: 1px; /* disappears if both height and border are 0 */
    width: 25%;
    margin-right: 15px;
    margin-left: 11px;
  }

  /* allow time strings to overlap preceding section separators */
  :global(.section-separator + .super-container.timed) {
    margin-top: -24px;
  }

  .show-all {
    display: flex;
    justify-content: center;
    align-items: center;
    color: #999;
    height: 40px;
    font-size: 16px;
    font-family: Avenir Next, Helvetica;
    background: #222;
    border-radius: 4px;
    cursor: pointer;
    margin: 4px 0;
  }

  /* override italic comment style of sunburst */
  :global(.hljs-comment) {
    font-style: normal;
    color: #666;
  }
  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    #user {
      height: 41px; /* must match height of single-line editor (on narrow window) */
    }
  }
</style>

{#if user && allowedUsers.includes(user.uid) && !error}
  <!-- all good! user logged in, has permissions, and no error from server -->
  <div class="items" class:multi-column={columnCount > 1}>
    {#each { length: columnCount } as _, column}
      <div class="column">
        {#if column == 0}
          <div
            id="header"
            bind:this={headerdiv}
            on:click={() => textArea(-1).focus()}>
            <div id="header-container" class:focused>
              <div id="editor">
                <Editor
                  bind:text={editorText}
                  bind:focused
                  cancelOnDelete={true}
                  allowCommandBracket={true}
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
            <div id="status" on:click={onStatusClick}>
              <span id="console-summary" on:click={onConsoleSummaryClick} />
              <span class="dots">
                {#each { length: dotCount } as _}•{/each}
              </span>
              <div class="counts">
                {@html oldestTimeString.replace(/(\D+)/, '<span class="unit">$1</span>')}&nbsp;
                {@html numberWithCommas(textLength).replace(/,/g, '<span class="comma">,</span>') + '<span class="unit">B</span>'}&nbsp;
                {items.length}
                {#if matchingItemCount > 0}
                  &nbsp;<span class="matching">{matchingItemCount}</span>
                {/if}
              </div>
              <div
                id="console"
                bind:this={consolediv}
                on:click={onConsoleClick} />
            </div>
          </div>
          <!-- auto-focus on the editor unless on iPhone -->
          {#if loggedIn}
            <script>
              // NOTE: we do not auto-focus the editor on the iPhone, which generally does not allow
              //       programmatic focus except in click handlers, when returning to app, etc
              if (
                document.activeElement.tagName.toLowerCase() != "textarea" &&
                !navigator.platform.startsWith("iPhone")
              )
                document.getElementById("textarea-editor").focus();
            </script>
          {/if}
        {/if}

        {#each items as item (item.id)}
          {#if item.column == column && item.index < maxIndexToShow}
            <Item
              onEditing={onItemEditing}
              onFocused={onItemFocused}
              onRun={onItemRun}
              onTouch={onItemTouch}
              onResized={onItemResized}
              {onTagClick}
              {onLogSummaryClick}
              onPrev={onPrevItem}
              onNext={onNextItem}
              bind:text={item.text}
              bind:editing={item.editing}
              bind:focused={item.focused}
              bind:saving={item.saving}
              bind:running={item.running}
              bind:showLogs={item.showLogs}
              bind:height={item.height}
              bind:time={item.time}
              index={item.index}
              id={item.id}
              label={item.label}
              labelUnique={item.labelUnique}
              hash={item.hash}
              deephash={item.deephash}
              missingTags={item.missingTags.join(' ')}
              matchingTerms={item.matchingTerms.join(' ')}
              matchingTermsSecondary={item.matchingTermsSecondary.join(' ')}
              timeString={item.timeString}
              timeOutOfOrder={item.timeOutOfOrder}
              updateTime={item.updateTime}
              createTime={item.createTime}
              dotted={item.dotted}
              runnable={item.runnable}
              scripted={item.scripted}
              macroed={item.macroed} />
            {#if item.nextColumn >= 0}
              <div class="section-separator">
                <hr />
                {item.index + 2}<span class="arrows"> {item.arrows} </span>
                &nbsp;
                {#if item.nextItemInColumn >= 0}
                  {item.nextItemInColumn + 1}<span class="arrows">↓</span>
                {/if}
                <hr />
              </div>
            {/if}
          {:else if item.column == column && item.index == maxIndexToShow}
            <div class="show-all" on:click={() => (maxIndexToShow = Infinity)}>
              show all
              {items.length}
              items
            </div>
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
  <div id="loading">
    <DoubleBounce size="60" unit="px" />
  </div>
{:else if !user && !error}
  <!-- user not logged in and no errors from server yet (login in progress) -->
  <div id="loading">
    <Circle2 size="60" unit="px" />
  </div>
{:else}
  <!-- should not happen -->
  ?
{/if}

<svelte:window
  on:keypress={onKeyPress}
  on:error={onError}
  on:unhandledrejection={onError}
  on:popstate={onPopState}
  on:scroll={onScroll} />
