<script context="module" lang="ts">
  import _ from "lodash";
  import { isClient, firebase, firestore } from "../../firebase.js";
  // NOTE: Preload function can be called on either client or server
  // See https://sapper.svelte.dev/docs#Preloading
  export async function preload(page, session) {
    return process["server-preload"](page, session);
  }
</script>

<script lang="ts">
  import { Circle2 } from "svelte-loading-spinners";
  import Editor from "../components/Editor.svelte";
  import Item from "../components/Item.svelte";
  import { tick } from "svelte";
  export let items = [];
  export let error = null;
  let user = null;
  let deletedItems = [];
  let editingItems = [];
  let focusedItem = -1;
  let focused = false;
  let anonymous = false;
  let readonly = false;

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
  let maxIndexToShowDefault = 50;
  let maxIndexToShow = maxIndexToShowDefault;
  let newestTime = 0;
  let oldestTime = Infinity;
  let oldestTimeString = "";
  let defaultHeaderHeight = 0;
  let defaultItemHeight = 0; // if zero, initial layout will be single-column
  let totalItemHeight = 0;
  let lastLayoutTime = 0;

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
    columnHeights[0] = headerdiv ? headerdiv.offsetHeight : defaultHeaderHeight; // first column includes header
    let lastTimeString = "";
    let topMovedIndex = items.length;
    newestTime = 0;
    oldestTime = Infinity;
    oldestTimeString = "";
    totalItemHeight = 0;
    lastLayoutTime = Date.now();

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
      if (item.time > newestTime) newestTime = item.time;

      item.timeString = "";
      item.timeOutOfOrder = false;
      if (!item.pinned && (index == 0 || timeString != lastTimeString)) {
        item.timeString = timeString;
        item.timeOutOfOrder =
          index > 0 && !lastItem.pinned && item.time > lastItem.time && timeString != lastTimeString;
      }
      lastTimeString = timeString;

      // calculate item height (zero if dotted, or not yet calculated and default is zero)
      item.outerHeight = item.dotted ? 0 : item.height || defaultItemHeight;
      // add item margins + time string height
      if (item.outerHeight > 0) item.outerHeight += 8 + (item.timeString ? 24 : 0);
      totalItemHeight += item.height; // used to hide items until height available

      // determine item column
      item.nextColumn = -1;
      item.nextItemInColumn = -1;

      if (index == 0) item.column = 0;
      else {
        // stay on same column unless column height would exceed minimum column height by 90% of screen height
        const lastColumn = lastItem.column;
        const minColumnHeight = Math.min(...columnHeights);
        if (
          columnHeights[lastColumn] <= minColumnHeight + 0.5 * outerHeight ||
          columnHeights[lastColumn] + item.outerHeight + 40 <= minColumnHeight + 0.9 * outerHeight
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
      // if non-dotted item is first in its column and missing time string, add it now
      if (!item.dotted && columnItems[item.column] < 0 && !item.timeString) {
        item.timeString = timeString;
        // add time string height now, assuming we are not ignoring item height
        if (item.outerHeight > 0) item.outerHeight += 24;
      }
      columnHeights[item.column] += item.outerHeight;
      if (columnItems[item.column] >= 0) {
        items[columnItems[item.column]].nextItemInColumn = index;
        // if item is below section-separator and has timeString, discount -24px negative margin
        if (columnItems[item.column] != index - 1 && item.timeString) columnHeights[item.column] -= 24;
      }
      columnItems[item.column] = index;
    });

    if (focusedItem >= 0) {
      // maintain focus/selection
      let textarea = textArea(focusedItem);
      if (textarea) {
        let selectionStart = textarea.selectionStart;
        let selectionEnd = textarea.selectionEnd;
        setTimeout(() => {
          textarea = textArea(focusedItem);
          if (!textarea) return;
          textarea.focus();
          textarea.selectionStart = selectionStart;
          textarea.selectionEnd = selectionEnd;
        }); // allow dom update before refocus
      }
    }
    // scroll up to top moved item if necessary
    if (topMovedIndex < items.length) {
      setTimeout(() => {
        // allow dom update before calculating new position
        const div = document.querySelector("#super-container-" + items[topMovedIndex].id);
        if (!div) return; // item hidden
        const itemTop = (div as HTMLElement).offsetTop;
        if (itemTop < window.scrollY) {
          // console.debug("scrolling up", itemTop, window.scrollY);
          window.top.scrollTo(0, itemTop);
        }
      });
    }
  }

  function isSpecialTag(tag) {
    return (
      tag == "#log" ||
      tag == "#menu" ||
      tag == "#context" ||
      tag == "#init" ||
      tag == "#async" ||
      tag == "#debug" ||
      tag.match(/^#pin(?:\/|$)/) ||
      tag.match(/\/pin(?:\/|$)/)
    );
  }

  // returns "alternative tags" for dependency analysis and tag search/highlights
  function altTags(tag) {
    if (tag == "#log") return ["#features/log"];
    else if (tag == "#menu") return ["#features/_menu"];
    else if (tag == "#context") return ["#features/_context"];
    else if (tag == "#init") return ["#features/_init"];
    else if (tag == "#async") return ["#features/_async"];
    else if (tag.match(/(?:\/|#)pin(?:\/|$)/)) return ["#features/_pin"];
    else return [];
  }

  function tagPrefixes(tag) {
    let pos;
    let prefixes = [];
    while ((pos = tag.lastIndexOf("/")) >= 0) prefixes.push((tag = tag.slice(0, pos)));
    return prefixes;
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
  let finalizeStateOnEditorChange = false;
  function onEditorChange(text: string) {
    // keep history entry 0 updated, reset index on changes
    if (text != sessionHistory[sessionHistoryIndex]) {
      sessionHistoryIndex = 0;
      if (sessionHistory.length == 0) sessionHistory = [text];
      else sessionHistory[0] = text;
    }

    // if editor has focus, and it is too soon since last change/return, debounce
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
    // console.debug("onEditorChange", editorText);
    lastEditorChangeTime = Infinity; // force minimum wait for next change
    maxIndexToShow = maxIndexToShowDefault; // reset item truncation

    text = text.toLowerCase().trim();
    const tags = parseTags(text);
    let terms = _.uniq(
      text
        .split(/\s+/)
        .concat(tags.all)
        .concat(_.flattenDeep(tags.all.map(altTags)))
        // .concat(_.flatten(tags.all.map(tagPrefixes)))
        // NOTE: for tags that do not match (or not sufficiently), we allow matching tag as non-tag with many variations, but we still prioritize/highlight tag matches and tag prefix (secondary) matches
        .concat(
          _.flattenDeep(
            tags.all.map((t) => {
              if (tagCounts.get(t) > 0) return [];
              // if (idsFromLabel.get(t)?.length > 0) return [];
              return [t.substring(1)].concat(tagPrefixes(t.substring(1))).concat(t.split("/"));
            })
          )
        )
    ).filter((t) => t);
    // disable search for text starting with '/', to provide a way to disable search, and to ensure search results do not interfere with commands that create new items or modify existing items
    if (text.startsWith("/")) terms = [];

    // expand tag prefixes into termsContext
    let termsContext = _.flatten(tags.all.map(tagPrefixes));

    matchingItemCount = 0;
    textLength = 0;
    let listing = [];
    let context = [];
    let listingItemIndex = -1;
    let idMatchItemIndices = [];

    // determine "listing" item w/ unique label matching first term
    // (in reverse order w/ listing item label last so larger is better and missing=-1)
    if (idsFromLabel.get(terms[0])?.length == 1) {
      listingItemIndex = indexFromId.get(idsFromLabel.get(terms[0])[0]);
      let item = items[listingItemIndex];
      context = [item.label].concat(item.labelPrefixes);
      // expand context to include "context" items that visibly tag the top item in context
      // (also add their label to context terms so they are highlighted as context as well)
      while (true) {
        const lastContextLength = context.length;
        items.forEach((ctxitem) => {
          if (ctxitem.id == item.id) return;
          if (
            ctxitem.context &&
            ctxitem.labelUnique &&
            !context.includes(ctxitem.label) &&
            _.intersection(ctxitem.tagsVisible, context).length > 0
          ) {
            context.push(ctxitem.label);
            if (ctxitem.labelPrefixes.length > 0) context = _.uniq(context.concat(ctxitem.labelPrefixes));
          }
        });
        if (context.length == lastContextLength) break;
      }
      termsContext = _.uniq(termsContext.concat(context));

      listing = item.tagsVisible
        .filter((t) => t != item.label)
        .slice()
        .reverse()
        .concat(item.label);
      // console.debug(listing);
    }

    items.forEach((item, index) => {
      textLength += item.text.length;

      // match query terms against visible tags in item
      item.tagMatches = _.intersection(item.tagsVisible, terms).length;

      // prefix-match first query term against item header text
      // (only for non-tags or unique labels, e.g. not #todo prefix once applied to multiple items)
      item.prefixMatch =
        item.header.startsWith(terms[0]) && (!terms[0].startsWith("#") || idsFromLabel.get(terms[0])?.length <= 1);

      // find "pinned match" term = hidden tags containing /pin with prefix match on first term
      item.pinnedMatchTerm = item.tagsHidden.find((t) => t.startsWith(terms[0]) && t.match(/\/pin(?:\/|$)/)) || "";
      item.pinnedMatch = item.pinnedMatchTerm.length > 0;

      // set uniqueLabel for shortening code below
      // NOTE: doing this here is easier than keeping these updated in itemTextChanged
      item.uniqueLabel = item.labelUnique ? item.label : "";
      // item.uniqueLabelPrefixes = item.labelUnique ? item.labelPrefixes : [];

      // match tags against item tagsAlt (expanded using altTags), allowing prefix matches
      item.matchingTerms = terms.filter((t) => t[0] == "#" && item.tagsAlt.findIndex((tag) => tag.startsWith(t)) >= 0);

      // match non-tag terms (anywhere in text)
      item.matchingTerms = item.matchingTerms.concat(terms.filter((t) => t[0] != "#" && item.lctext.includes(t)));

      // match regex:* terms as regex
      item.matchingTerms = item.matchingTerms.concat(
        terms.filter((t) => t.match(/^regex:\S+/) && item.lctext.match(new RegExp(t.substring(6))))
      );
      // match id:* terms against id
      const idMatchTerms = terms.filter((t) => t.match(/^id:\w+/) && item.id.toLowerCase() == t.substring(3));
      item.matchingTerms = item.matchingTerms.concat(idMatchTerms);
      if (idMatchTerms.length > 0) idMatchItemIndices.push(index);
      item.matchingTerms = _.uniq(item.matchingTerms); // can have duplicates (e.g. regex:*, id:*, ...)

      // match "secondary terms" ("context terms" against expanded tags, non-tags against item deps/dependents)
      item.matchingTermsSecondary = _.uniq(
        _.concat(
          termsContext.filter(
            (t) =>
              item.tagsExpanded.includes(t) ||
              item.depsString.toLowerCase().includes(t) ||
              item.dependentsString.toLowerCase().includes(t)
          ),
          terms.filter(
            (t) =>
              t[0] != "#" &&
              (item.depsString.toLowerCase().includes(t) || item.dependentsString.toLowerCase().includes(t))
          )
        )
      );

      // item is considered matching if primary terms match
      // (i.e. secondary terms are used only for ranking and highlighting matching tag prefixes)
      // (this is consistent with .index.matching in Item.svelte)
      if (item.matchingTerms.length > 0) matchingItemCount++;

      // calculate missing tags (excluding certain special tags from consideration)
      // NOTE: doing this here is easier than keeping these updated in itemTextChanged
      // NOTE: tagCounts include prefix tags, deduplicated at item level
      item.missingTags = item.tags.filter((t) => t != item.label && !isSpecialTag(t) && (tagCounts.get(t) || 0) <= 1);
      // allow special tags to be missing if they are visible
      item.missingTags = item.missingTags.concat(
        item.tagsVisible.filter((t) => t != item.label && isSpecialTag(t) && (tagCounts.get(t) || 0) <= 1)
      );
      // if (item.missingTags.length > 0) console.debug(item.missingTags, item.tags);

      item.hasError = item.text.match(/(?:^|\n)(?:ERROR|WARNING):/) != null;
    });

    // Update (but not save yet) times for editing and running non-log items to maintain ordering
    // among running/editing items within their sort level (see ordering logic below)
    let now = Date.now();
    items.forEach((item) => {
      if ((item.editing || item.running) && !item.log) item.time = now;
    });

    // Update time for listing item (but not save yet, a.k.a. "soft touch")
    // NOTE: we may add a few ms to the current time to dominate other recent touches (e.g. tag clicks)
    if (listingItemIndex >= 0 && !items[listingItemIndex].log) items[listingItemIndex].time = Date.now() + 2; // prioritize

    // Update times for id-matching items (but not save yet, a.k.a. "soft touch")
    idMatchItemIndices.forEach((index) => {
      if (!items[index].log) items[index].time = Date.now() + 1; // prioritize
    });

    // update history, replace unless current state is final (from tag click)
    if (history.state.editorText != editorText) {
      // need to update history
      const state = {
        editorText: editorText,
        unsavedTimes: _.compact(
          items.map((item) => (item.time != item.savedTime ? _.pick(item, ["id", "time"]) : null))
        ),
        final: !editorText || finalizeStateOnEditorChange,
      };
      // console.debug(history.state.final ? "push" : "replace", state);
      if (history.state.final) history.pushState(state, editorText);
      else history.replaceState(state, editorText);
    }
    finalizeStateOnEditorChange = false; // processed above

    // returns position of minimum non-negative number, or -1 if none found
    function min_pos(xJ) {
      let jmin = -1;
      for (let j = 0; j < xJ.length; ++j) if (xJ[j] >= 0 && (jmin < 0 || xJ[j] < xJ[jmin])) jmin = j;
      return jmin;
    }

    // NOTE: this assignment is what mainly triggers toHTML in Item.svelte
    //       (even assigning a single index, e.g. items[0]=items[0] triggers toHTML on ALL items)
    //       (afterUpdate is also triggered by the various assignments above)
    // NOTE: undefined values produce NaN, which is treated as 0
    items = stableSort(
      items,
      (a, b) =>
        // dotted? (contains #_pin/dot or #_pin/dot/*)
        b.dotted - a.dotted ||
        // alphanumeric ordering on #_pin/dot/* term (see https://stackoverflow.com/a/38641281)
        a.dotTerm.localeCompare(b.dotTerm, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        // pinned? (contains #_pin or #_pin/*)
        b.pinned - a.pinned ||
        // alphanumeric ordering on #_pin/* term
        a.pinTerm.localeCompare(b.pinTerm, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        // pinned match? (contains /pin or /pin/*)
        b.pinnedMatch - a.pinnedMatch ||
        // alphanumeric ordering on #*/pin/* term
        a.pinnedMatchTerm.localeCompare(b.pinnedMatchTerm, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        // listing item context position (includes labelPrefixes)
        context.indexOf(b.uniqueLabel) - context.indexOf(a.uniqueLabel) ||
        // position of (unique) label in listing item (item w/ unique label = first term)
        // (listing is reversed so larger index is better and missing=-1)
        listing.indexOf(b.uniqueLabel) - listing.indexOf(a.uniqueLabel) ||
        // editing mode (except log items)
        (!b.log && b.editing) - (!a.log && a.editing) ||
        // # of matching (visible) tags from query
        b.tagMatches - a.tagMatches ||
        // // // position of longest matching label prefix in listing item
        // // min_pos(listing.map((pfx) => b.uniqueLabelPrefixes.indexOf(pfx))) -
        // //   min_pos(listing.map((pfx) => a.uniqueLabelPrefixes.indexOf(pfx))) ||
        // prefix match on first term
        b.prefixMatch - a.prefixMatch ||
        // # of matching words/tags from query
        b.matchingTerms.length - a.matchingTerms.length ||
        // # of matching secondary words from query
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

  function onTagClick(id: string, tag: string, reltag: string, e: MouseEvent) {
    const index = indexFromId.get(id);
    if (index == undefined) return; // deleted
    // "soft touch" item if not already newest and not pinned and not log
    if (items[index].time > newestTime) console.warn("invalid item time");
    else if (items[index].time < newestTime && !items[index].pinned && !items[index].log)
      items[index].time = Date.now();

    // NOTE: Rendered form of tag should be renderTag(reltag). We use common suffix to map click position.
    const rendered = renderTag(reltag);
    let suffix = rendered;
    while (!tag.endsWith(suffix)) suffix = suffix.substring(1);
    if (suffix) {
      // calculate partial tag prefix (e.g. #tech for #tech/math) based on position of click
      let range = document.caretRangeFromPoint(
        e.pageX - document.documentElement.scrollLeft,
        e.pageY - document.documentElement.scrollTop
      );
      if (range) {
        let tagNode = e.target as Node;
        // if target is not the tag node, it must be a highlight, so we move to the parent
        if ((tagNode as HTMLElement).tagName != "MARK") tagNode = tagNode.parentNode;
        // console.debug("tag click: ", range.startOffset, clickNode, tagNode.childNodes);
        // if tag node contains highlight, we have to adjust click position
        let pos = range.startOffset;
        for (const child of Array.from(tagNode.childNodes)) {
          if (child.contains(range.startContainer)) break;
          pos += child.textContent.length;
        }
        // adjust pos from rendered to full tag ...
        pos = Math.max(pos, rendered.length - suffix.length);
        pos = tag.length - suffix.length + (pos - (rendered.length - suffix.length));
        // we only take partial tag if the current tag is "selected" (i.e. full exact match)
        // (makes it easier to click on tags without accidentally getting a partial tag)
        // if ((tagNode as HTMLElement).classList.contains("selected"))
        tag = tag.substring(0, pos) + tag.substring(pos).match(/^[^\/]*/)[0];
      } else {
        console.warn("got null range for tag click: ", tag, e);
      }
    } else {
      // NOTE: this can happen for link tags where rendered text is arbitrary, and without a common suffix we just take the full tag
      // console.warn("could not find matching suffix", tag, rendered);
    }
    tag = tag.replace(/^#_/, "#"); // ignore hidden tag prefix
    // if (editorText.trim() == tag) {
    //   history.back();
    //   return;
    // }
    editorText = editorText.trim() == tag ? "" : tag + " "; // space in case more text is added
    // editorText = tag + " ";
    finalizeStateOnEditorChange = true; // finalize state
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange(editorText);
  }

  function onLinkClick(id: string, href: string, e: MouseEvent) {
    const index = indexFromId.get(id);
    if (index == undefined) return; // deleted
    // "soft touch" item if not already newest and not pinned and not log
    if (items[index].time > newestTime) console.warn("invalid item time");
    else if (items[index].time < newestTime && !items[index].pinned && !items[index].log) {
      items[index].time = Date.now();
      onEditorChange(editorText); // item time has changed
    }
  }

  function onLogSummaryClick(id: string) {
    let index = indexFromId.get(id);
    if (index == undefined) return;
    items[index].showLogs = !items[index].showLogs;
    items[index].showLogsTime = Date.now(); // invalidates auto-hide
  }

  function onPopState(e) {
    readonly = anonymous && !location.href.endsWith("#__anonymous");
    if (!e?.state) return; // for fragment (#id) hrefs
    // console.debug("pop", e.state);
    // restore editor text and unsaved times
    editorText = e.state.editorText || "";
    if (e.state.unsavedTimes) {
      items.forEach((item) => (item.time = item.savedTime));
      e.state.unsavedTimes.forEach((entry) => {
        const index = indexFromId.get(entry.id);
        if (index == undefined) return;
        items[index].time = entry.time;
      });
    }
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange(editorText);
  }

  function resetUser() {
    user = null;
    localStorage.removeItem("user");
    window.sessionStorage.removeItem("signin_pending");
    document.cookie = "__session=;max-age=0"; // delete cookie for server
  }

  function signOut() {
    if (!firebase().auth().currentUser) return; // not logged in yet, so ignore click for now
    resetUser();
    firebase()
      .auth()
      .signOut()
      .then(() => {
        console.log("signed out");
        location.reload();
      })
      .catch(console.error);
  }

  let idsFromLabel = new Map<string, string[]>();
  function itemDeps(index, deps = []) {
    let item = items[index];
    if (deps.includes(item.id)) return deps;
    // NOTE: dependency order matters for hashing and potentially for code import
    deps = [item.id, ...deps]; // prepend temporarily to avoid cycles, moved to back below
    item.tagsHiddenAlt.forEach((tag) => {
      // NOTE: we allow special tags as dependents if corresponding uniquely named items exist
      // if (isSpecialTag(tag)) return;
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

  function itemDepsString(item) {
    return item.deps
      .filter((id) => id != item.id)
      .map((id) => {
        const dep = items[indexFromId.get(id)];
        const async = dep.async || dep.deps.map((id) => items[indexFromId.get(id)].async).includes(true);
        return (dep.labelUnique ? dep.labelText : "id:" + dep.id) + (async ? "(async)" : "");
      })
      .join(" ");
  }

  function itemDependentsString(item) {
    return item.dependents
      .map((id) => {
        const dep = items[indexFromId.get(id)];
        return (
          (dep.labelUnique ? dep.labelText : "id:" + dep.id) +
          (item.labelUnique && dep.tagsVisible.includes(item.label) ? "(visible)" : "")
        );
      })
      .join(" ");
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
    item.tagsHidden = tags.hidden;
    item.tagsRaw = tags.raw;
    item.tagsAlt = _.uniq(_.flattenDeep(item.tags.concat(item.tags.map(altTags))));
    item.tagsHiddenAlt = _.uniq(_.flattenDeep(item.tagsHidden.concat(item.tagsHidden.map(altTags))));
    // item.log = item.tags.includes("#log"); (must be label, see below)
    item.context = item.tagsRaw.includes("#_context");
    item.init = item.tagsRaw.includes("#_init");
    item.async = item.tagsRaw.includes("#_async");
    item.debug = item.tagsRaw.includes("#_debug");
    const pintags = item.tagsRaw.filter((t) => t.match(/^#_pin(?:\/|$)/));
    item.pinned = pintags.length > 0;
    item.pinTerm = pintags[0] || "";
    item.dotted = pintags.findIndex((t) => t.match(/^#_pin\/dot(?:\/|$)/)) >= 0;
    item.dotTerm = pintags.filter((t) => t.match(/^#_pin\/dot(?:\/|$)/))[0] || "";

    // if item stats with a visible tag, it is taken as a "label" for the item
    // (we allow some tags/macros to precede the label tag for styling purposes)
    const prevLabel = item.label;
    item.header = item.lctext.replace(/^<.*>\s+#/, "#").match(/^.*?(?:\n|$)/)[0];
    item.label = item.header.startsWith(item.tagsVisible[0]) ? item.tagsVisible[0] : "";
    item.labelText = item.label ? item.text.replace(/^<.*>\s+#/, "#").match(/^#\S+/)[0] : "";
    if (item.labelUnique == undefined) item.labelUnique = false;
    if (item.labelPrefixes == undefined) item.labelPrefixes = [];
    if (item.label) {
      // convert relative tags to absolute
      const resolveTag = (tag) => (tag.startsWith("#/") ? item.label + tag.substring(1) : tag);
      item.tags = item.tags.map(resolveTag);
      item.tagsVisible = item.tagsVisible.map(resolveTag);
      item.tagsHidden = item.tagsHidden.map(resolveTag);
      item.tagsRaw = item.tagsRaw.map(resolveTag);
      item.tagsAlt = item.tagsAlt.map(resolveTag);
      item.tagsHiddenAlt = item.tagsHiddenAlt.map(resolveTag);
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
      while ((pos = label.lastIndexOf("/")) >= 0) item.labelPrefixes.push((label = label.slice(0, pos)));
    }
    item.log = item.label == "#log";

    // compute expanded tags including prefixes
    const prevTagsExpanded = item.tagsExpanded || [];
    item.tagsExpanded = item.tags.slice();
    item.tags.forEach((tag) => {
      item.tagsExpanded = item.tagsExpanded.concat(tagPrefixes(tag));
    });
    item.tagsExpanded = _.uniq(item.tagsExpanded);
    if (!_.isEqual(item.tagsExpanded, prevTagsExpanded)) {
      prevTagsExpanded.forEach((tag) => tagCounts.set(tag, tagCounts.get(tag) - 1));
      item.tagsExpanded.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1));
    }

    if (update_deps) {
      const prevDeps = item.deps || [];
      const prevDependents = item.dependents || [];
      item.deps = itemDeps(index);
      // console.debug("updated dependencies:", item.deps);

      const prevDeepHash = item.deephash;
      item.deephash = hashCode(item.deps.map((id) => items[indexFromId.get(id)].hash).join(","));
      if (item.deephash != prevDeepHash && !item.log) item.time = Date.now();
      // we have to update deps/deephash for all dependent items
      // NOTE: changes to deephash trigger re-rendering and cache invalidation
      // NOTE: we only need to update dependencies on first update_deps or if item label has changed
      if (!item.dependents || prevLabel != item.label) {
        item.dependents = [];
        items.forEach((depitem, depindex) => {
          if (depindex == index) return; // skip self
          depitem.deps = itemDeps(depindex);
          const prevDeepHash = depitem.deephash;
          depitem.deephash = hashCode(depitem.deps.map((id) => items[indexFromId.get(id)].hash).join(","));
          if (depitem.deps.includes(item.id)) item.dependents.push(depitem.id);
        });
        // console.debug("updated dependents:", item.dependents);
      }
      // update deps/dependents strings
      item.depsString = itemDepsString(item);
      item.dependentsString = itemDependentsString(item);
      _.uniq(item.deps.concat(prevDeps)).forEach((id) => {
        if (id == item.id) return;
        const dep = items[indexFromId.get(id)];
        if (item.deps.includes(dep.id) && !dep.dependents.includes(item.id)) dep.dependents.push(item.id);
        else if (!item.deps.includes(dep.id) && dep.dependents.includes(item.id))
          dep.dependents = dep.dependents.filter((id) => id != item.id);
        dep.dependentsString = itemDependentsString(dep);
        // console.debug("updated dependentsString:", dep.dependentsString);
      });
      _.uniq(item.dependents.concat(prevDependents)).forEach((id) => {
        const dep = items[indexFromId.get(id)];
        dep.depsString = itemDepsString(dep);
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

  let sessionCounter = 0; // to ensure unique increasing temporary ids for this session
  let sessionHistory = [];
  let sessionHistoryIndex = 0;
  let tempIdFromSavedId = new Map<string, string>();
  let editorText = "";
  function onEditorDone(text: string, e: KeyboardEvent = null, cancelled: boolean = false, run: boolean = false) {
    if (cancelled) {
      if (e?.code == "Escape") {
        textArea(-1).blur();
      } else {
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange((editorText = ""));
      }
      return;
    }

    // reset history index, update entry 0 and unshift duplicate entry
    // NOTE: we do not depend on onEditorChange keeping entry 0 updated, even though it should
    sessionHistoryIndex = 0;
    if (sessionHistory[0] != text.trim())
      if (sessionHistory.length == 0) sessionHistory = [text.trim()];
      else sessionHistory[0] = text.trim();
    sessionHistory.unshift(sessionHistory[0]);

    let time = Date.now(); // default time is current, can be past if undeleting
    let origText = text.trim();
    let clearLabel = false; // force clear, even if text starts with tag
    // NOTE: default is to create item in editing mode, unless any 2+ modifiers are held
    //       (or edit:true|false is specified by custom command function)
    //       (some modifier combinations, e.g. Ctrl+Alt, may be blocked by browsers)
    let editing = (e.metaKey ? 1 : 0) + (e.ctrlKey ? 1 : 0) + (e.altKey ? 1 : 0) < 2;

    switch (text.trim()) {
      case "/_signout": {
        if (!firebase().auth().currentUser) {
          alert("already signed out");
          return;
        }
        signOut();
        return;
      }
      case "/_signin": {
        signIn();
        return;
      }
      case "/_count": {
        text = `${editingItems.length} items are selected`;
        break;
      }
      case "/_times": {
        if (editingItems.length == 0) {
          alert("/times: no item selected");
          return;
        }
        let item = items[editingItems[0]];
        text = `${new Date(item.time)}\n${new Date(item.updateTime)}\n${new Date(item.createTime)}`;
        break;
      }
      case "/_dependencies": {
        if (editingItems.length == 0) {
          alert("/_dependencies: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/_dependencies: too many items selected");
          return;
        }
        text = items[editingItems[0]].depsString;
        clearLabel = true;
        break;
      }
      case "/_dependents": {
        if (editingItems.length == 0) {
          alert("/_dependents: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/_dependents: too many items selected");
          return;
        }
        text = items[editingItems[0]].dependentsString;
        clearLabel = true;
        break;
      }
      case "/_debug": {
        if (!lastRunText) {
          alert(`/_debug: no runs (in this session)`);
          return;
        }
        text = "#_debug " + lastRunText;
        editing = true;
        break;
      }
      case "/_debug_eval": {
        if (!lastEvalText) {
          alert(`/_debug_eval: no _eval calls (in this session)`);
          return;
        }
        text = "#_debug " + lastEvalText;
        editing = true;
        break;
      }
      case "/_backup": {
        if (readonly) return;
        let added = 0;
        items.forEach((item) => {
          firestore()
            .collection("history")
            .add({
              item: item.id,
              user: user.uid,
              time: item.time,
              text: item.text,
            })
            .then((doc) => {
              console.debug(`"added ${++added} of ${items.length} items to history`);
            })
            .catch(console.error);
        });
        return;
      }
      case "/_tweet": {
        if (editingItems.length == 0) {
          alert("/_tweet: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/_tweet: too many items selected");
          return;
        }
        let item = items[editingItems[0]];
        location.href = "twitter://post?message=" + encodeURIComponent(item.text);
        return;
      }
      case "/_duplicate": {
        if (editingItems.length == 0) {
          alert("/_duplicate: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/_duplicate: too many items selected");
          return;
        }
        let item = items[editingItems[0]];
        time = item.time;
        text = item.text;
        editing = true;
        break;
      }
      case "/_undelete": {
        if (deletedItems.length == 0) {
          alert("/_undelete: nothing to undelete (in this session)");
          return;
        }
        time = deletedItems[0].time;
        text = deletedItems[0].text;
        deletedItems.shift();
        editing = false;
        break;
      }
      default: {
        if (text.match(/^\/\w+/)) {
          const cmd = text.match(/^\/\w+/)[0];
          const args = text
            .replace(/^\/\w+/, "")
            .trim()
            .replace(/`/g, "\\`");
          if (idsFromLabel.has("#commands" + cmd)) {
            try {
              const obj = window["_eval"](`run(\`${args}\`)`, "#commands" + cmd);
              if (!obj) {
                onEditorChange((editorText = ""));
                return;
              } else if (typeof obj == "string") {
                onEditorChange((editorText = obj));
                return;
              } else if (typeof obj != "object" || !obj.text || typeof obj.text != "string") {
                alert(
                  `#commands${cmd}: run(\`${args}\`) returned invalid value; must be of the form {text:"...",edit:true|false}`
                );
                return;
              }
              text = obj.text;
              if (obj.edit != undefined)
                // if undefined use key-based default
                editing = obj.edit == true;
            } catch (e) {
              alert(`#commands${cmd}: ${e}`);
              throw e;
            }
          } else {
            alert(`unknown command ${cmd}`);
            return;
          }
        } else if (text.match(/^\/\s+/s)) {
          // clear /(space) as a mechanism to disable search
          // (onEditorChange already ignores text starting with /)
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
      id: (Date.now() + sessionCounter++).toString(), // temporary id for this session only
      savedId: null, // filled in below after save
      editing: editing,
      saving: !editing,
      savedTime: time,
      savedText: "", // so cancel = delete
    };
    items = [item, ...items];

    // update indices as needed by itemTextChanged
    items.forEach((item, index) => indexFromId.set(item.id, index));
    itemTextChanged(0, text);

    // NOTE: command can do this if indeed useful
    // if command, just clear the arguments, keep the command
    // (useful for repeated commands of the same type)
    // if (editorText.match(/^\/\w+ ?/)) {
    //   editorText = editorText.replace(/(^\/\w+ ?).*$/s, "$1");
    // } else {
    // if not command, but starts with a tag, keep if non-unique label
    // (useful for adding labeled items, e.g. todo items, without losing context)
    editorText =
      !clearLabel &&
      items[0].label &&
      !items[0].labelUnique &&
      items[0].labelText &&
      editorText.startsWith(items[0].labelText + " ")
        ? items[0].labelText + " "
        : "";
    // }

    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange(editorText); // integrate new item at index 0

    if (run) {
      // NOTE: appendJSOutput can trigger _writes that trigger saveItem, which will be skip due to saveId being null
      appendJSOutput(indexFromId.get(item.id));
      text = itemToSave.text = item.text; // no need to update editorText
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
      .collection(readonly ? "items-tmp" : "items")
      .add(itemToSave)
      .then((doc) => {
        let index = indexFromId.get(item.id); // since index can change
        tempIdFromSavedId.set(doc.id, item.id);
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
        // if editing, we do not call onItemSaved so save is postponed to post-edit, and cancel = delete
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
        // also save to history (using persistent doc.id) ...
        if (!readonly) {
          firestore()
            .collection("history")
            .add({ item: doc.id, ...itemToSave })
            .catch(console.error);
        }
      })
      .catch(console.error);
  }

  function focusOnNearestEditingItem(index: number) {
    // console.debug("focusOnNearestEditingItem", index, editingItems);
    let near = Math.min(...editingItems.filter((i) => i > index && i < maxIndexToShow));
    if (near == Infinity) near = Math.max(...[-1, ...editingItems.filter((i) => i < maxIndexToShow)]);
    focusedItem = near;
    // if (near == -1) return; // do not auto-focus on editor
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

  let lastEditTime = 0; // updated in onItemEdited
  let layoutPending = false;
  function onItemResized(id, container, trigger: string) {
    if (!container) return;
    const index = indexFromId.get(id);
    if (index == undefined) return;
    let item = items[index];
    // exclude any ._log elements since they are usually collapsed
    let logHeight = 0;
    container.querySelectorAll("._log").forEach((log) => (logHeight += log.offsetHeight));
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
    if (
      height == 0 ||
      prevHeight == 0 ||
      height != prevHeight
      // height < 0.5 * prevHeight ||
      // height > prevHeight + 100
    ) {
      if (!layoutPending) {
        layoutPending = true;
        const layoutInterval = setInterval(
          () => {
            // TODO: if this does not prevent the edit issues, consider waiting until no item editor has focus
            if (Date.now() - lastEditTime >= 500) {
              updateItemLayout();
              layoutPending = false;
              clearInterval(layoutInterval);
            }
          },
          // if totalItemHeight == 0, then we have not yet done any layout with item heights available, so we do not want to delay too long, but just want to give it enough time for heights to be reasonably accurate
          totalItemHeight > 0 ? 250 : 50
        );
      }
    }
  }

  function itemShowLogs(id: string, autohide_after: number = 15000) {
    let index = indexFromId.get(id);
    if (index == undefined) return;
    items[index].showLogs = true;
    const dispatchTime = (items[index].showLogsTime = Date.now());
    if (autohide_after > 0) {
      setTimeout(() => {
        let index = indexFromId.get(id);
        if (index == undefined) return;
        if (dispatchTime == items[index].showLogsTime) items[index].showLogs = false;
      }, autohide_after);
    }
  }

  function itemUpdateRunning(id: string, running: boolean) {
    let index = indexFromId.get(id);
    if (index == undefined) return;
    // console.debug("itemUpdateRunning", id, running);
    if (items[index].running != running) {
      items[index].running = running;
      if (running) {
        items[index].runStartTime = Date.now();
        items[index].runEndTime = 0;
      } else {
        items[index].runEndTime = Date.now();
      }
    }
    items[index] = items[index]; // trigger dom update
  }

  let evalItemId = [];
  function evalJSInput(text: string, text_nodeps: string, label: string = "", index: number): any {
    let jsin = extractBlock(text, "js_input");
    let jsin_nodeps = extractBlock(text_nodeps, "js_input");
    if (jsin.length == 0) return undefined;
    let item = items[index];
    jsin = jsin.replace(/(^|[^\\])\$id/g, "$1" + item.id);
    jsin = jsin.replace(/(^|[^\\])\$hash/g, "$1" + item.hash);
    jsin = jsin.replace(/(^|[^\\])\$deephash/g, "$1" + item.deephash);
    // const evaljs = jsin;
    // const evaljs = "(function(){\n" + jsin + "\n})()";
    let evaljs = jsin;
    if (!item.debug && (item.async || item.deps.map((id) => items[indexFromId.get(id)].async).includes(true))) {
      if (!jsin_nodeps.match(/\bdone\b/)) {
        let msg = "can not run async code block without any reference to completion callback function 'done'";
        if (label) msg = label + ": " + msg;
        alert(msg);
        return undefined;
      }
      evaljs = [
        "(async function(done) {",
        `await _running('${item.id}')`,
        jsin,
        "})(function(output) {",
        `  if (output) _write('${item.id}', output)`,
        `  _done('${item.id}')`,
        "})",
      ].join("\n");
    }
    if (!item.debug) evaljs = `const __id='${item.id}';\n` + evaljs;
    if (lastRunText) lastRunText = appendBlock(lastRunText, "js_input", addLineNumbers(evaljs));
    const start = Date.now();
    try {
      evalItemId.push(item.id);
      // NOTE: we do not set item.running for sync eval since dom state could not change, and since the eval could trigger an async chain that also sets item.running and would be disrupted if we set it to false here.
      let out = eval(evaljs);
      evalItemId.pop();
      // automatically _write_log into item
      window["_write_log"](item.id, start);
      return out;
    } catch (e) {
      evalItemId.pop();
      let msg = e.toString();
      if (label) msg = label + ": " + msg;
      if (console["_eval_error"]) console["_eval_error"](msg);
      else alert(msg);
      // automatically _write_log into item
      window["_write_log"](item.id, start);
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
      text = text.replace(RegExp(regex, "gs"), () => (count++ == 0 ? block : empty));
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
      let prefix = item.debug
        ? "" // #_debug items are assumed self-contained if they are run
        : window["_read_deep"]("js", item.id, { replace_ids: true });
      if (prefix) prefix = "```js_input\n" + prefix + "\n```\n";
      let jsout = evalJSInput(prefix + item.text, item.text, item.label, index) || "";
      // ignore output if Promise
      if (jsout instanceof Promise) jsout = undefined;
      const outputConfirmLength = 16 * 1024;
      if (jsout && jsout.length >= outputConfirmLength) {
        if (!confirm(`Write ${jsout.length} bytes (_output) into ${item.label || `item ${item.index + 1}`}?`))
          jsout = undefined;
      }
      if (jsout) item.text = appendBlock(item.text, "_output", jsout);
      // NOTE: index can change during JS eval due to _writes
      itemTextChanged(indexFromId.get(item.id), item.text);
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
    if (!item.savedId) {
      // NOTE: this can happen due to appendJSOutput for new item on onEditorDone()
      // console.error("item is not being saved but also does not have its permanent id");
      return;
    }
    item.saving = true;
    let itemToSave = {
      time: item.time,
      text: item.text,
    };
    if (readonly) {
      // if read-only, we can only "update" items added (to items-tmp) in this session
      if (tempIdFromSavedId.get(item.savedId)) {
        firestore()
          .collection("items-tmp")
          .doc(item.savedId)
          .update({ user: user.uid, ...itemToSave })
          .then(() => {
            onItemSaved(item.id, itemToSave);
          })
          .catch(console.error);
      } else {
        firestore()
          .collection("items-tmp")
          .add({ user: user.uid, ...itemToSave })
          .then((doc) => {
            let index = indexFromId.get(item.id);
            if (index == undefined) return; // deleted
            items[index].savedId = doc.id;
            onItemSaved(item.id, itemToSave);
            tempIdFromSavedId.set(items[index].savedId, item.id); // can update next time
          })
          .catch(console.error);
      }
    } else {
      firestore()
        .collection(readonly ? "items-tmp" : "items")
        .doc(item.savedId)
        .update(itemToSave)
        .then(() => {
          onItemSaved(item.id, itemToSave);
        })
        .catch(console.error);
    }

    if (!readonly) {
      // also save to history ...
      firestore()
        .collection("history")
        .add({ user: user.uid, item: item.savedId, ...itemToSave })
        .catch(console.error);
    }
  }

  // https://stackoverflow.com/a/9039885
  function iOS() {
    return (
      ["iPad Simulator", "iPhone Simulator", "iPod Simulator", "iPad", "iPhone", "iPod"].includes(navigator.platform) ||
      // iPad on iOS 13 detection
      (navigator.userAgent.includes("Mac") && "ontouchend" in document)
    );
  }

  function onItemEditing(index: number, editing: boolean, cancelled: boolean = false, run: boolean = false) {
    // console.debug(`item ${index} editing: ${editing}, editingItems:${editingItems}, focusedItem:${focusedItem}`);
    let item = items[index];

    // update time for non-log item
    if (!item.log) item.time = Date.now();

    // if cancelled, restore savedText
    // NOTE: we do not restore time so item remains "soft touched"
    if (cancelled) {
      // item.time = item.savedTime;
      item.text = item.savedText;
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
        // we can skip delete if read-only and item not created under items-tmp
        if (item.savedId && (!readonly || tempIdFromSavedId.get(item.savedId))) {
          firestore()
            .collection(readonly ? "items-tmp" : "items")
            .doc(item.savedId)
            .delete()
            .catch(console.error);
        }
      } else {
        itemTextChanged(index, item.text);
        // clear _output and execute javascript unless cancelled
        if (run && !cancelled) {
          // empty out any *_output|*_log blocks as they should be re-generated
          item.text = item.text.replace(/(^|\n) *```(\w*?_output)\n(?: *```|.*?\n *```) *(\n|$)/gs, "$1```$2\n```$3");
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
        if (!cancelled && (item.time != item.savedTime || item.text != item.savedText)) saveItem(item.id);
        onEditorChange(editorText); // item time and/or text may have changed
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
  }

  // WARNING: onItemFocused may NOT be invoked when editor is destroyed
  function onItemFocused(index: number, focused: boolean) {
    if (focused) focusedItem = index;
    else focusedItem = -1;
    // console.debug(
    //   `item ${index} focused: ${focused}, focusedItem:${focusedItem}`
    // );
  }

  function onItemEdited(index: number, text: string) {
    lastEditTime = Date.now();
  }

  function onItemRun(index: number = -1) {
    if (index < 0) index = focusedItem;
    let item = items[index];
    // empty out any *_output|*_log blocks as they should be re-generated
    item.text = item.text.replace(/(^|\n) *```(\w*?_output)\n(?: *```|.*?\n *```) *(\n|$)/gs, "$1```$2\n```$3");
    item.text = item.text.replace(
      /(^|\n) *```(\w*?_log)\n(?: *```|.*?\n *```) *(\n|$)/gs,
      "$3" // remove so errors do not leave empty blocks
    );
    itemTextChanged(index, item.text); // updates tags, label, deps, etc before JS eval
    appendJSOutput(index);
    item.time = Date.now();
    if (!item.editing) saveItem(item.id);
    lastEditorChangeTime = 0; // force immediate update (editor should not be focused but just in case)
    onEditorChange(editorText); // item time/text has changed
  }

  function onItemTouch(index: number) {
    if (items[index].log) {
      alert("#log item can not be moved up");
      return;
    } // ignore
    if (items[index].time > newestTime) console.warn("invalid item time");
    else if (items[index].time < newestTime) {
      items[index].time = Date.now();
      saveItem(items[index].id);
      lastEditorChangeTime = 0; // force immediate update (editor should not be focused but just in case)
      onEditorChange(editorText); // item time has changed
      // onEditorChange((editorText = "")); // item time has changed, and editor cleared
    }
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
      let index = indexFromId.get(lastEditItem);
      if (index == undefined) return;
      textArea(index).focus();
      textArea(index).selectionStart = lastEditPosition;
    });
  }

  function textArea(index: number): HTMLTextAreaElement {
    return document.getElementById("textarea-" + (index < 0 ? "mindbox" : items[index].id)) as HTMLTextAreaElement;
  }

  function onPrevItem(inc = -1) {
    if (sessionHistoryIndex > 0 || focusedItem + inc < -1) {
      if (sessionHistoryIndex + 1 < sessionHistory.length) {
        sessionHistoryIndex++;
        // console.debug("sessionHistoryIndex", sessionHistoryIndex);
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange((editorText = sessionHistory[sessionHistoryIndex]));
        setTimeout(() => {
          textArea(-1).selectionStart = textArea(-1).selectionEnd = editorText.length;
        });
      }
      return;
    }
    const index = focusedItem;
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
    if (sessionHistoryIndex > 0) {
      sessionHistoryIndex--;
      // console.debug("sessionHistoryIndex", sessionHistoryIndex);
      lastEditorChangeTime = 0; // disable debounce even if editor focused
      onEditorChange((editorText = sessionHistory[sessionHistoryIndex]));
      setTimeout(() => {
        const endOfFirstLine = editorText.match(/^[^\n]*/)[0].length;
        textArea(-1).selectionStart = textArea(-1).selectionEnd = endOfFirstLine;
      });
      return;
    }
    if (focusedItem + inc >= Math.min(maxIndexToShow, items.length)) return;
    const index = focusedItem;
    if (!items[index + inc].editing) {
      if (items[index + inc].pinned || items[index + inc].saving || items[index + inc].running) {
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
    (document.querySelector("span.dots") as HTMLElement).style.display = showDotted ? "none" : "block";
    (document.querySelector("span.triangle") as HTMLElement).style.display = showDotted ? "block" : "none";
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
    if (window.scrollY <= -100 && !scrollToggleLocked && Date.now() - lastScrolledDownTime > 1000) {
      scrollToggleLocked = true;
      showDotted = !showDotted;
      // NOTE: display:none on any elements (even spans) while bouncing breaks the bounce animation on iOS
      // (playing around with visibility/height/position/etc did not work either)
      showDottedPending = true;
      (document.querySelector("span.dots") as HTMLElement).style.visibility = "visible";
      (document.querySelector("span.dots") as HTMLElement).style.opacity = "0.5";
      // attempt focus on editor (may not work on iOS)
      // document.getElementById("textarea-mindbox").focus();
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
    // NOTE: we log url for "error" Events that do not have message/reason
    //       (see https://www.w3schools.com/jsref/event_onerror.asp)
    if (!e.message && (e.type == "error" || (e.reason && e.reason.type == "error"))) {
      if (e.reason) e = e.reason;
      let url = e.target && (e.target["url"] || e.target["src"]) ? e.target["url"] || e.target["src"] : "(unknown url)";
      return `error loading ${url}`;
    }
    return e.reason
      ? `Unhandled Rejection: ${e.reason} (line:${e.reason.line}, col:${e.reason.column})`
      : e.message
      ? e.lineno
        ? `${e.message} (line:${e.lineno}, col:${e.colno})`
        : e.line
        ? `${e.message} (line:${e.line}, col:${e.column})`
        : e.stack // all we seem to have is a trace, so let's dump that ...
        ? `${e.message}; STACK TRACE:\n${e.stack
            .split("\n")
            .map((s) => "ERROR: - " + s)
            .join("\n")}`
        : e.message
      : undefined;
  }

  import { onMount } from "svelte";
  import { hashCode, numberWithCommas, extractBlock, parseTags, renderTag } from "../util.js";

  let consoleLog = [];
  const consoleLogMaxSize = 10000;
  const statusLogExpiration = 15000;

  let initTime = 0;
  function initialize() {
    indexFromId = new Map<string, number>(); // needed for initial itemTextChanged
    items.forEach((item, index) => indexFromId.set(item.id, index));
    items.forEach((item, index) => {
      itemTextChanged(index, item.text, false); // deps handled below after index assignment
      item.savedId = item.id;
      item.savedText = item.text;
      item.savedTime = item.time;
      // NOTE: we also initialized other state here to have a central listing
      // state used in onEditorChange
      item.tagMatches = 0;
      item.prefixMatch = false;
      item.pinnedMatch = false;
      item.pinnedMatchTerm = "";
      item.uniqueLabel = "";
      // item.uniqueLabelPrefixes = [];
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
      // dependents (filled below)
      item.dependents = [];
      item.dependentsString = "";
    });
    onEditorChange(""); // initial sorting
    items.forEach((item, index) => {
      // initialize deps, deephash, missing tags/labels
      item.deps = itemDeps(index);
      item.deephash = hashCode(item.deps.map((id) => items[indexFromId.get(id)].hash).join());
      item.deps.forEach((id) => {
        if (id != item.id) items[indexFromId.get(id)].dependents.push(item.id);
      });
    });
    items.forEach((item) => {
      item.depsString = itemDepsString(item);
      item.dependentsString = itemDependentsString(item);
      // dispatch evaluation of _init() on #_init items, excluding dependencies
      if (item.init) setTimeout(() => window["_eval"]("_init()", item.id, { include_deps: false }));
    });

    initTime = Math.round(performance.now());
    console.debug(`initialized ${items.length} items at ${initTime}ms`);
  }

  function signIn() {
    resetUser();
    let provider = new window.firebase.auth.GoogleAuthProvider();
    firebase().auth().useDeviceLanguage();
    // firebase().auth().setPersistence("none")
    // firebase().auth().setPersistence("session")
    firebase().auth().setPersistence("local");
    // NOTE: getRedirectResult() seem to be redundant given onAuthStateChanged
    window.sessionStorage.setItem("signin_pending", "1");
    document.cookie = "__session=signin_pending;max-age=600"; // temporary setting for server post-redirect
    firebase().auth().signInWithRedirect(provider);
    // NOTE: signInWithPopup also requires a reload since we are currently unable to cleanly re-initialize items via firebase realtime snapshot once they have already been initialize via server-side request; reloading allows the next server response to be ignored so that session cookie can be set; forced reload also means that we might as well do a redirect which can be cleaner anyway (esp. on mobile, as stated on https://firebase.google.com/docs/auth/web/google-signin)
    // firebase()
    //   .auth()
    //   .signInWithPopup(provider)
    //   .then(() => location.reload())
    //   .catch(console.error);
  }

  if (isClient) {
    // NOTE: We simply log the server side error as a warning. Currently only possible error is "invalid session cookie" (see session.ts), and assuming items are not returned/initialized below, firebase realtime should be able to initialize items without requiring a page reload, which is why this can be just a warning.
    if (error) console.warn(error); // log server-side error

    // pre-fetch user from localStorage instead of waiting for onAuthStateChanged
    // (seems to be much faster to render user.photoURL, but watch out for possible 403 on user.photoURL)
    if (!user && localStorage.getItem("user")) {
      user = JSON.parse(localStorage.getItem("user"));
      console.debug("restored user from local storage");
    } else if (window.sessionStorage.getItem("signin_pending")) {
      user = null;
    } else {
      document.cookie = "__session=;max-age=0"; // clear just in case
      user = {
        photoURL: "/incognito.png",
        displayName: "Anonymous",
        uid: "anonymous",
      };
    }
    anonymous = user?.uid == "anonymous";
    readonly = anonymous && !location.href.endsWith("#__anonymous");

    // if items were returned from server, confirm user, then initialize if valid
    if (items.length > 0) {
      if (window.sessionStorage.getItem("signin_pending")) {
        console.warn(`ignoring ${items.length} items received while signing in`);
        items = [];
      } else if (user && user.uid != items[0].user) {
        // items are for wrong user, usually anonymous, due to missing cookie
        // (you can test this with document.cookie='__session=;max-age=0' in console)
        console.warn(`ignoring ${items.length} items received for wrong user (${items[0].user})`);
        items = [];
      } else {
        // NOTE: at this point item heights (and totalItemHeight) will be zero and the loading indicator stays, but we need the items on the page to compute their heights, which will trigger updated layout through onItemResized
        initialize();
      }
    }

    // listen for auth state change if we are not anonymous ...
    if (!anonymous) {
      firebase()
        .auth()
        .onAuthStateChanged((authUser) => {
          // console.debug("onAuthStateChanged", user, authUser);
          resetUser(); // clean up first
          if (!authUser) return;
          user = authUser;
          console.log("signed in", user.email);
          localStorage.setItem("user", JSON.stringify(user));
          anonymous = readonly = false; // just in case (should already be false)

          // set up server-side session cookie
          // store user's ID token as a 1-hour __session cookie to send to server for preload
          // NOTE: __session is the only cookie allowed by firebase for efficient caching
          //       (see https://stackoverflow.com/a/44935288)
          user
            .getIdToken(false /*force refresh*/)
            .then((token) => {
              document.cookie = "__session=" + token + ";max-age=3600";
            })
            .catch(console.error);

          initFirebaseRealtime();
        });
    }

    window["_user"] = function () {
      if (!user) return null;
      return _.pick(user, ["email", "displayName", "photoURL", "uid"]);
    };

    function indicesForItem(item: string) {
      if (item.startsWith("id:")) {
        item = item.substring(3);
        if (indexFromId.has(item)) return [indexFromId.get(item)];
        else return undefined;
      }
      if (item == "auto" || item == "self" || item == "this") item = "";
      if (!item && evalItemId.length > 0) {
        // NOTE: there is ambiguity when there are multiple items in the stack; we currently resolve by returning the top-most item: could be rendered item with <script> or macro or run item with input block or via command
        // return [indexFromId.get(_.last(evalItemId))];
        return [indexFromId.get(evalItemId[0])]; // return top level caller, e.g. <script> item or run item
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
      // if multiple allowed, return as array, most recent first
      if (multiple) return _.sortBy(ids, (id) => -items[indexFromId.get(id)].time);
      if (ids.length > 1) console.warn(`multiple items matched _id(${item}), returning first`);
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
      if (labels.length > 1) console.warn(`multiple items matched _label(${item}), returning first`);
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

    window["_read"] = function (type: string = "", item: string = "", options: object = {}) {
      let content = [];
      let indices = indicesForItem(item);
      indices.map((index) => {
        let item = items[index];
        if (type == "js" || type == "webppl") content.push(`/* ${type} @ ${item.label || "id:" + item.id} */`);
        else if (type == "html") content.push(`<!-- ${type} @ ${item.label || "id:" + item.id} -->`);
        // NOTE: by convention, dependencies are included _before_ item itself
        if (options["include_deps"]) {
          options["include_deps"] = false; // deps are recursive already
          item.deps
            .filter((id) => id != item.id)
            .forEach((id) => {
              const index = indexFromId.get(id);
              if (index == undefined) return;
              if (
                options["exclude_async_deps"] &&
                (items[index].async || items[index].deps.map((id) => items[indexFromId.get(id)].async).includes(true))
              )
                return; // exclude async dependency chain
              content.push(window["_read"](options["dep_type"] || type, id, options));
            });
        }
        let text = type ? extractBlock(item.text, type) : item.text;
        // console.debug("_read", item.label, item.text, text);
        if (options["replace_ids"]) text = text.replace(/(^|[^\\])\$id/g, "$1" + item.id);
        content.push(text);
      });
      return content.filter((s) => s).join("\n");
    };

    // add include_deps
    window["_read_deep"] = function (type: string = "", item: string = "", options: object = {}) {
      return window["_read"](type, item, Object.assign({ include_deps: true }, options));
    };

    // reads type_input with a prefix of type w/ include_deps + replace_ids
    window["_read_input"] = function (type: string = "", item: string = "", options: object = {}) {
      return [
        window["_read_deep"](type, item, Object.assign({ replace_ids: true }, options)),
        window["_read"](type + "_input", item, options),
      ].join("\n");
    };

    window["_eval"] = function (code: string = "", item: string = "", options: object = {}) {
      let prefix = window["_read_deep"](
        "js",
        item,
        Object.assign({ replace_ids: true, exclude_async_deps: true }, options)
      );
      let caller = indicesForItem("")[0]; // index of invoking item (_id()) or undefined
      let indices = indicesForItem(item); // index of specified (eval) item
      if (indices.length > 1) console.warn("multiple items for _eval");
      let index = indices[0];

      let evaljs = prefix + "\n" + code;
      if (index != undefined) evaljs = `const __id='${items[index].id}';\n` + evaljs;

      lastEvalText = appendBlock(
        caller != undefined ? `\`_eval\` invoked from ${items[caller].label || "id:" + items[caller].id}` : "",
        "js_input",
        addLineNumbers(evaljs)
      );
      if (index != undefined) evalItemId.push(items[index].id);
      try {
        const out = eval(evaljs);
        if (index != undefined) evalItemId.pop();
        return out;
      } catch (e) {
        console.error(e);
        if (index != undefined) evalItemId.pop();
        throw e;
      }
    };

    window["_write"] = function (item: string, text: string, type: string = "_output") {
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
          if (!confirm(`Write ${text.length} bytes (${type}) into ${item.label || `item ${item.index + 1}`}?`)) return; // cancel write
        }
        // if writing *_log, clear any existing *_log blocks
        // (and skip write if block is empty)
        if (type.endsWith("_log")) {
          item.text = item.text.replace(/(^|\n) *```(\w*?_log)\n(?: *```|.*?\n *```) *(\n|$)/gs, "$3");
          if (text) item.text = appendBlock(item.text, type, text);
        } else {
          if (type == "") item.text = text;
          else item.text = appendBlock(item.text, type, text);
        }
        if (!item.log) item.time = Date.now();
        itemTextChanged(index, item.text);
        // we dispatch onEditorChange to prevent index changes _during_ JS eval
        setTimeout(() => {
          lastEditorChangeTime = 0; // disable debounce even if editor focused
          onEditorChange(editorText); // item time/text has changed
          saveItem(item.id);
        });
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
        log.push(prefix + entry.text); // exclude prefix assuming redundant
      }
      log = log.reverse();
      return log.join("\n");
    };

    window["_write_log"] = function (item: string, since: number = -1, level: number = 1, type: string = "_log") {
      const log = window["_read_log"](since, level);
      window["_write"](item, log, type);
      if (type == "_log") window["_show_logs"](item);
    };

    window["_show_logs"] = function (item: string, autohide_after: number = 15000) {
      indicesForItem(item).map((index) => itemShowLogs(items[index].id, autohide_after));
    };

    window["_task"] = function (interval: number, task: Function, item: string = "") {
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
        counts[num == max ? bins - 1 : Math.floor((num - min) / size)] += weights[index];
      });
      let histogram = {};
      const sample_max = Math.max(...numbers);
      counts.forEach((count, index) => {
        const lower = (min + index * size).toFixed(digits);
        const upper = index == bins - 1 ? max.toFixed(digits) : (min + (index + 1) * size).toFixed(digits);
        let key = `[${lower}, ${upper}` + (index == bins - 1 && sample_max == max ? "]" : ")");
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

    window["_pmf"] = function (dist, limit: number = 10, digits: number = 2, keydigits: number = 2) {
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

    window["_running"] = function (id: string = "", running: boolean = true) {
      if (!id) {
        if (evalItemId.length == 0) {
          console.error("_running() invoked from async javascript or macro");
          return;
        }
        id = _.last(evalItemId);
      }
      const index = indexFromId.get(id);
      if (index == undefined) return Promise.resolve(); // ignore missing
      if (items[index].running == running) return Promise.resolve(); // no change
      itemUpdateRunning(id, running);
      return new Promise<void>((resolve) => {
        const index = indexFromId.get(id);
        if (index == undefined) return;
        // NOTE: tick() did not work to ensure the spinner is visible for cpu-intensive javascript. even polling for loading indicator did not work reliably, so we are forced to leave it to calling code to introduce a delay() as needed before expensive compute
        tick().then(() => resolve());
      });
    };

    window["_done"] = function (id: string, log_type: string = "_log", log_level: number = 1) {
      const index = indexFromId.get(id);
      if (index == undefined) return Promise.resolve(); // ignore missing
      if (!items[index].running) return Promise.resolve(); // ignore not running
      if (items[index].donePending) return Promise.resolve(); // duplicate _done
      items[index].donePending = true;
      return new Promise<void>((resolve) => {
        window["_running"](id, false).then(() => {
          const index = indexFromId.get(id);
          if (index == undefined) return;
          delete items[index].donePending;
          if (log_type) window["_write_log"](id, items[index].runStartTime, log_level, log_type);
          resolve();
        });
      });
    };

    window["_array"] = function (length: number, func) {
      let array = new Array(length);
      for (let i = 0; i < length; ++i) array[i] = func(i);
      return array;
    };

    // Visual viewport resize/scroll handlers ...
    // NOTE: we use document width because it is invariant to zoom scale but sensitive to font size
    //       (also window.outerWidth can be stale after device rotation in iOS Safari)
    let lastDocumentWidth = 0;
    function checkLayout() {
      if (Date.now() - lastScrollTime < 250) return; // will be invoked again via setInterval
      const documentWidth = document.documentElement.clientWidth;
      if (documentWidth != lastDocumentWidth) {
        // console.debug(
        //   `document width changed from ${lastDocumentWidth} to ${documentWidth}`
        // );
        updateItemLayout();
        // resize of all elements w/ _resize attribute (and property)
        document.querySelectorAll("[_resize]").forEach((elem) => elem["_resize"]());
        lastDocumentWidth = documentWidth;
        return;
      }
      if (Date.now() - lastLayoutTime > 60000) {
        // console.debug(
        //   `updating layout after more than a minute since last layout`
        // );
        updateItemLayout();
        return;
      }
    }
    visualViewport.addEventListener("resize", checkLayout);
    visualViewport.addEventListener("scroll", onScroll);

    let firstSnapshot = true;
    function initFirebaseRealtime() {
      if (!user || user.uid == "anonymous") return; // should not be invoked for anonymous

      // start listening for remote changes
      // (also initialize if items were not returned by server)
      firebase()
        .firestore()
        .collection("items")
        .where("user", "==", user.uid)
        .orderBy("time", "desc")
        .onSnapshot(
          function (snapshot) {
            if (firstSnapshot) {
              // console.debug(
              //   `onSnapshot invoked at ${Math.round(
              //     window.performance.now()
              //   )}ms w/ ${items.length} items`
              // );
              setTimeout(() => {
                console.debug(`${items.length} items synchronized at ${Math.round(window.performance.now())}ms`);
                if (!initTime) initialize();
                firstSnapshot = false;
              });
            }
            snapshot.docChanges().forEach(function (change) {
              const doc = change.doc;
              // on first snapshot, we only need to append for initalize (see above)
              // and only if items were not returned by server (and initialized) already
              // (otherwise we can just skip the first snapshot, which is hopefully coming
              //  from a local cache so that it is cheap and worse than the server snapshot)
              if (firstSnapshot) {
                if (change.type != "added") console.warn("unexpected change type: ", change.type);
                if (!initTime) {
                  // NOTE: snapshot items do not have updateTime/createTime available
                  items.push(Object.assign(doc.data(), { id: doc.id }));
                }
                return;
              }
              if (doc.metadata.hasPendingWrites) return; // ignore local change
              // no need to log initial snapshot
              // console.debug("detected remote change:", change.type, doc.id);
              if (change.type === "added") {
                // NOTE: remote add is similar to onEditorDone without js, saving, etc
                let item = Object.assign(doc.data(), {
                  id: doc.id,
                  savedId: doc.id,
                  savedTime: doc.data().time,
                  savedText: doc.data().text,
                });
                items = [item, ...items];
                // update indices as needed by itemTextChanged
                items.forEach((item, index) => indexFromId.set(item.id, index));
                itemTextChanged(0, item.text);
                lastEditorChangeTime = 0; // disable debounce even if editor focused
                onEditorChange(editorText); // integrate new item at index 0
              } else if (change.type == "removed") {
                // NOTE: remote remove is similar to onItemEditing (deletion case)
                // NOTE: document may be under temporary id if it was added locally
                let index = indexFromId.get(tempIdFromSavedId.get(doc.id) || doc.id);
                if (index == undefined) return; // nothing to remove
                let item = items[index];
                itemTextChanged(index, ""); // clears label, deps, etc
                items.splice(index, 1);
                lastEditorChangeTime = 0; // disable debounce even if editor focused
                onEditorChange(editorText); // deletion can affect ordering (e.g. due to missingTags)
                deletedItems.unshift({
                  time: item.savedTime,
                  text: item.savedText,
                }); // for /undelete
              } else if (change.type == "modified") {
                // NOTE: remote modify is similar to _write without saving
                // NOTE: document may be under temporary id if it was added locally
                let index = indexFromId.get(tempIdFromSavedId.get(doc.id) || doc.id);
                if (index == undefined) return; // nothing to modify
                let item = items[index];
                item.text = item.savedText = doc.data().text;
                item.time = items[index].savedTime = doc.data().time;
                // since there is no
                itemTextChanged(index, item.text); // updates label, deps, etc
                lastEditorChangeTime = 0; // disable debounce even if editor focused
                onEditorChange(editorText); // item time/text has changed
              }
            });
          },
          (error) => {
            if (error.code == "permission-denied")
              alert(
                `This account requires activation. Plese email support@mind.page from your email address ${user.email} and specify your account id:${user.uid}. Signing you out for now!`
              );
            console.error(error);
            signOut();
          }
        );
    }

    onMount(() => {
      // copy console into #console (if it exists)
      // NOTE: some errors do not go through console.error but are reported via window.onerror
      console["_window_error"] = () => {}; // no-op, used to redirect window.onerror
      console["_eval_error"] = () => {}; // no-op, used to redirect error during evalJSInput()
      const levels = ["debug", "info", "log", "warn", "error", "_window_error", "_eval_error"];
      levels.forEach(function (verb) {
        console[verb] = (function (method, verb, div) {
          return function (...args) {
            method(...args);
            if (!consolediv) return;
            var elem = document.createElement("div");
            if (verb.endsWith("error")) verb = "error";
            elem.classList.add("console-" + verb);
            // NOTE: we indicate full eval stack as prefix
            let prefix = evalItemId
              .map((id) => {
                const item = items[indexFromId.get(id)];
                return item.labelText || item.id;
              })
              .join(">");
            if (prefix) prefix += ": ";
            let text = "";
            if (args.length == 1 && errorMessage(args[0])) text = errorMessage(args[0]);
            else text = args.join(" ") + "\n";
            elem.textContent = prefix + text;
            elem.setAttribute("_time", Date.now().toString());
            elem.setAttribute("_level", levels.indexOf(verb).toString());
            consolediv.appendChild(elem);
            consoleLog.push({
              type: verb,
              prefix: prefix,
              text: text.trim(),
              time: Date.now(),
              level: levels.indexOf(verb),
            });
            if (consoleLog.length > consoleLogMaxSize) consoleLog = consoleLog.slice(consoleLogMaxSize / 2);

            document.getElementById("console-summary").style.visibility = showDotted ? "hidden" : "visible";
            const summarydiv = document.getElementById("console-summary");
            const summaryelem = document.createElement("span");
            summaryelem.innerText = "·";
            summaryelem.classList.add("console-" + verb);
            summarydiv.appendChild(summaryelem);

            // if console is hidden, make sure summary is visible
            if (consolediv.style.display == "none") summarydiv.style.visibility = "visible";

            // auto-remove after 15 seconds ...
            setTimeout(() => {
              elem.remove();
              summaryelem.remove();
              if (consolediv.childNodes.length == 0) {
                consolediv.style.display = "none";
                summarydiv.style.visibility = "visible";
              }
            }, statusLogExpiration);
          };
        })(console[verb].bind(console), verb);
      });
      if (anonymous) console.log("user is anonymous");
      if (initTime) console.debug(`${items.length} items initialized at ${initTime}ms`);

      updateDotted(); // update dotted items
      setInterval(checkLayout, 250); // check layout every 250ms

      // console.debug(
      //   `onMount invoked at ${Math.round(window.performance.now())}ms w/ ${
      //     items.length
      //   } items`
      // );
    });

    console.debug(`index.js executed at ${Math.round(window.performance.now())}ms w/ ${items.length} items`);
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
      (e.code == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
      (e.code == "KeyS" && (e.metaKey || e.ctrlKey)) ||
      (e.code == "Slash" && (e.metaKey || e.ctrlKey)) ||
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
    let msg = errorMessage(e);
    if (console["_window_error"]) console["_window_error"](msg);
    else alert(msg);
  }
</script>

<div class="items" class:multi-column={columnCount > 1}>
  {#each { length: columnCount } as _, column}
    <div class="column">
      {#if column == 0}
        <div id="header" bind:this={headerdiv} on:click={() => textArea(-1).focus()}>
          <div id="header-container" class:focused>
            <div id="editor">
              <Editor
                id="mindbox"
                bind:text={editorText}
                bind:focused
                cancelOnDelete={true}
                allowCommandCtrlBracket={true}
                onEdited={onEditorChange}
                onDone={onEditorDone}
                onPrev={onPrevItem}
                onNext={onNextItem}
              />
            </div>
            <div class="spacer" />
            {#if user}
              <img
                id="user"
                class:anonymous
                class:readonly
                src={user.photoURL}
                alt={user.displayName || user.email}
                title={user.displayName || user.email}
                on:click={() => (!user.email ? signIn() : signOut())}
              />
            {/if}
          </div>
          <div id="status" on:click={onStatusClick}>
            <span id="console-summary" on:click={onConsoleSummaryClick} />
            <span class="dots">
              {#each { length: dotCount } as _}•{/each}
            </span>
            <span class="triangle"> ▲ </span>
            {#if items.length > 0}
              <div class="counts">
                {@html oldestTimeString.replace(/(\D+)/, '<span class="unit">$1</span>')}&nbsp;
                {@html numberWithCommas(textLength).replace(/,/g, '<span class="comma">,</span>') +
                  '<span class="unit">B</span>'}&nbsp;
                {items.length}
                {#if matchingItemCount > 0}
                  &nbsp;<span class="matching">{matchingItemCount}</span>
                {/if}
              </div>
            {/if}
            <div id="console" bind:this={consolediv} on:click={onConsoleClick} />
          </div>
        </div>
      {/if}

      {#each items as item (item.id)}
        {#if item.column == column && item.index < maxIndexToShow}
          <Item
            onEditing={onItemEditing}
            onFocused={onItemFocused}
            onEdited={onItemEdited}
            onRun={onItemRun}
            onTouch={onItemTouch}
            onResized={onItemResized}
            {onTagClick}
            {onLinkClick}
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
            labelText={item.labelText}
            hash={item.hash}
            deephash={item.deephash}
            missingTags={item.missingTags.join(" ")}
            matchingTerms={item.matchingTerms.join(" ")}
            matchingTermsSecondary={item.matchingTermsSecondary.join(" ")}
            timeString={item.timeString}
            timeOutOfOrder={item.timeOutOfOrder}
            updateTime={item.updateTime}
            createTime={item.createTime}
            depsString={item.depsString}
            dependentsString={item.dependentsString}
            dotted={item.dotted}
            runnable={item.runnable}
            scripted={item.scripted}
            macroed={item.macroed}
          />
          {#if item.nextColumn >= 0}
            <div class="section-separator">
              <hr />
              {item.index + 2}<span class="arrows">{item.arrows}</span>{#if item.nextItemInColumn >= 0}
                &nbsp;
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

{#if !user || !initTime || totalItemHeight == 0}
  <div id="loading">
    <Circle2 size="60" unit="px" />
  </div>
{:else}<script>
    setTimeout(() => {
      // NOTE: we do not auto-focus the editor on the iPhone, which generally does not allow
      //       programmatic focus except in click handlers, when returning to app, etc
      if (document.activeElement.tagName.toLowerCase() != "textarea" && !navigator.platform.startsWith("iPhone"))
        document.getElementById("textarea-mindbox").focus();
    });
  </script>{/if}

<svelte:window
  on:keypress={onKeyPress}
  on:error={onError}
  on:unhandledrejection={onError}
  on:popstate={onPopState}
  on:scroll={onScroll}
/>

<style>
  #loading {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    width: 100%;
    height: 100%;
    min-height: -webkit-fill-available;
    justify-content: center;
    align-items: center;
    /* NOTE: if you add transparency, initial zero-height layout will be visible */
    background: rgba(17, 17, 17, 1);
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
    width: 44px;
    min-width: 44px; /* seems necessary to ensure full width inside flex */
    margin-right: 4px;
    border-radius: 50%;
    background: #222;
    cursor: pointer;
    overflow: hidden;
  }
  #user.anonymous:not(.readonly) {
    background: red;
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
    white-space: pre-wrap;
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
    /* fill full height of page even if no items are shown */
    height: 100%;
    min-height: -webkit-fill-available;
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
    display: flex;
    align-items: center;
    justify-content: center;
    height: 40px; /* 40px offset height assumed by column layout */
    color: #444; /* same as time indicators */
    font-size: 16px;
    font-family: Avenir Next, Helvetica;
  }
  .section-separator .arrows {
    margin-bottom: 5px; /* aligns better w/ surrounding text */
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
    margin: 0 15px;
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
      width: 41px;
      min-width: 41px;
    }
  }
</style>
