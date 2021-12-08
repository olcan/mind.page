<script lang="ts">
  import { marked } from 'marked'
  import { numberWithCommas } from '../util.js'
  export let onPastedImage = (url: string, file: File, size_handler = null) => {}

  let content = ''
  let confirm = ''
  let cancel = ''
  let input = null
  let password = false
  let username = ''
  let autocomplete = ''
  let images = false
  let canConfirm = (input: string) => input.length > 0
  let onConfirm = (input = null) => {}
  let onCancel = () => {}
  let background = '' // can be "confirm", "cancel", or "block"; default ("") is block OR close if no confirm/cancel buttons
  let selected_images = [] // used internally for file input
  let ready_image_count = 0
  let _visible = false
  let enabled = false
  $: enabled =
    (input == null || canConfirm(input)) &&
    (!images || (selected_images.length > 0 && ready_image_count == selected_images.length))

  const defaults = {
    content,
    confirm,
    cancel,
    input,
    password,
    username,
    autocomplete,
    images,
    canConfirm,
    onConfirm,
    onCancel,
    background,
  }

  let inputelem: HTMLInputElement
  let pending_options = new Map() // options for pending modals
  let pending_outputs = new Map() // outputs for cancelled modals
  let promise_pending // promise for all modals (visible AND pending)
  let promise_visible // promise for currently visible modal
  let resolve_visible // resolve callback for visible promise
  export function show(options) {
    const promise = (promise_pending = Promise.allSettled([promise_pending]).then(
      () =>
        new Promise(resolve => {
          promise_visible = promise
          resolve_visible = resolve
          // fetch/remove options from pending option map
          // if no options, modal was cancelled before shown
          const options = pending_options.get(promise)
          pending_options.delete(promise)
          if (!options) {
            const output = pending_outputs.get(promise)
            pending_outputs.delete(promise)
            resolve_visible(output)
            promise_visible = null
            resolve_visible = null
            _visible = false
            return
          }
          ;({
            content,
            confirm,
            cancel,
            input,
            password,
            username,
            autocomplete,
            images,
            canConfirm,
            onConfirm,
            onCancel,
            background,
          } = Object.assign({ ...defaults }, options))
          // console.debug(options, confirm, cancel);
          selected_images = []
          ready_image_count = 0
          _visible = true

          // hacky "fix" for Chrome autofill onchange bug https://stackoverflow.com/a/62199697
          // chrome fails to trigger onchange and enable confirm button despite autofill
          const isSafari = navigator.userAgent.toLowerCase().indexOf('safari/') > -1
          if (!isSafari && input != null && autocomplete) {
            const promise_visible_at_dispatch = promise_visible
            const checkForChromeAutofill = () => {
              if (promise_visible != promise_visible_at_dispatch) return // cancel
              try {
                if (inputelem?.matches(':-internal-autofill-selected')) {
                  input = inputelem.value // did not work in experiments but just in case
                  enabled = true
                }
                setTimeout(checkForChromeAutofill, 100)
              } catch (e) {
                // report errors as warnings
                console.warn(e)
              }
            }
            checkForChromeAutofill() // start checking
          }
        })
    ))
    // store options in pending_options, subject to change in update()
    pending_options.set(promise, options)
    return promise
  }

  // update specific modal identified by its promise
  // could be any modal, visible or pending
  export function update(promise, options) {
    // if modal is not visible yet, just update pending options and return
    if (promise_visible != promise) {
      if (!pending_options.has(promise)) throw new Error(`invalid promise for modal update`)
      pending_options.set(promise, options)
      return promise
    }
    // update visible modal
    ;({
      content,
      confirm,
      cancel,
      input,
      password,
      username,
      autocomplete,
      images,
      canConfirm,
      onConfirm,
      onCancel,
      background,
    } = Object.assign(
      {
        content,
        confirm,
        cancel,
        input,
        password,
        username,
        autocomplete,
        images,
        canConfirm,
        onConfirm,
        onCancel,
        background,
      },
      options
    ))
    return promise
  }

  // close/cancel all modals or specific modal identified by its promise
  // can also resolve specific modal w/ specified output
  export function close(promise = undefined, output = undefined) {
    if (!promise) {
      // cancel all pending modals w/ undefined output
      if (output) throw new Error(`can not return output when closing all modals`)
      pending_options.clear() // cancel all pending modals
      // NOTE: we allow modals closed earlier to get any specified outputs
      // pending_outputs.clear() // also clear pending outputs (forcing undefined)
    } else {
      // close specified modal
      // if modal is not visible yet, just cancel and return
      // cancel means move promise from pending_options to pending_outputs
      if (promise_visible != promise) {
        if (!pending_options.has(promise)) throw new Error(`invalid promise for modal close`)
        pending_options.delete(promise) // cancel promise
        pending_outputs.set(promise, output) // save output for resolve
        return promise
      }
    }
    // resolve and close any visible modal
    if (_visible) {
      resolve_visible(output)
      promise_visible = null
      resolve_visible = null
      _visible = false
    }
    return promise
  }

  // returns true iff specified (or any) modal is visible
  export function visible(promise = undefined) {
    if (promise) return promise_visible == promise
    return _visible
  }

  function _onConfirm(e = null) {
    e?.stopPropagation()
    e?.preventDefault()
    if (!enabled) return
    const output = images ? selected_images : input != null ? input : true
    onConfirm(output)
    // resolve and close visible modal
    resolve_visible(output)
    promise_visible = null
    resolve_visible = null
    _visible = false
  }

  function _onCancel(e = null) {
    e?.stopPropagation()
    e?.preventDefault()
    if (!cancel) return
    onCancel()
    // resolve and close visible modal
    const output = images ? [] : input != null ? null : false
    resolve_visible(output)
    promise_visible = null
    resolve_visible = null
    _visible = false
  }

  function onBackgroundClick(e = null) {
    if (e && (e.target as HTMLElement).closest('.modal')) return // ignore click on modal
    e?.stopPropagation()
    e?.preventDefault()
    if (!confirm && !cancel && background.toLowerCase() != 'block') close(promise_visible)
    else if (confirm && background.toLowerCase() == 'confirm') _onConfirm(e)
    else if (cancel && background.toLowerCase() == 'cancel') _onCancel(e)
    // else block
  }

  function onKeyDown(e: KeyboardEvent) {
    const key = e.code || e.key // for android compatibility
    // NOTE: modal is on top of the page and handles ALL key events
    if (!_visible) return // ignore if not visible

    // always stop Enter and Escape
    // also stop all non-modal non-modifier key events as a modal should
    if (
      key == 'Enter' ||
      key == 'Escape' ||
      (!(e.target as HTMLElement).closest('.modal') && !e.metaKey && !e.ctrlKey && !e.altKey)
    ) {
      e.stopPropagation()
      e.preventDefault()
    }

    // dispatch to keep modal visible and prevent handling by window onKeyDown (in Index.svelte)
    setTimeout(() => {
      if (key == 'Enter') _onConfirm()
      else if (key == 'Escape') onBackgroundClick()
    })
  }

  function onFilesSelected(e) {
    let input = e.target as HTMLInputElement
    selected_images = []
    ready_image_count = 0
    Array.from(input.files).map((file, index) => {
      const url = URL.createObjectURL(file)
      let image = {
        url: url,
        name: file.name,
        type: file.type,
        fname: null,
        size: null,
      }
      selected_images.push(image)
      Promise.resolve(
        onPastedImage(url, file, size => {
          if (selected_images[index]?.url != url) return // cancelled
          selected_images[index].size = size
        })
      ).then(fname => {
        if (selected_images[index]?.url != url) return // cancelled
        selected_images[index].fname = fname
        ready_image_count++
      })
    })
  }

  function replaceNakedURLs(text) {
    // replace naked urls w/ links <a href="$1" target="_blank">$1</a>
    // similar to replaceURLs in Item.svelte but applied _after_ markdown->html conversion
    // means this can replace urls e.g. in code blocks
    return text.replace(/(^|.?)(https?:\/\/[^\s)<]*)/g, (m, pfx, url) => {
      // try to maintain html attributes, other url strings, etc
      if (pfx.match(/[="'`:]$/)) return m // : can be from generated urls, e.g. blob:http://localhost//...
      // move certain suffixes out of url into suffix
      let sfx = url.match(/(?:[\.,;:]|:\d+:\d+)$/)?.pop() ?? ''
      if (sfx) url = url.slice(0, -sfx.length)
      try {
        let obj = new URL(url)
        return `${pfx}<a href="${url}" target="_blank">${url}</a>${sfx}`
      } catch (_) {
        return pfx + url + sfx
      }
    })
  }
</script>

<div class="background" class:visible={_visible} on:click={onBackgroundClick}>
  <div class="modal">
    {#if content}{@html replaceNakedURLs(marked.parse(content))}{/if}
    {#if input != null}
      <!-- for Chrome warnings, we wrap in form and add username of type "text" -->
      <form>
        {#if password}
          <input type="text" name="username" value={username} autocomplete="username" style="display:none" />
          <input
            id="modal-input"
            type="password"
            name="password"
            bind:value={input}
            bind:this={inputelem}
            {autocomplete}
            on:keydown={onKeyDown}
          />
        {:else}
          <input id="modal-input" bind:value={input} on:keydown={onKeyDown} bind:this={inputelem} {autocomplete} />
        {/if}
      </form>
    {/if}
    {#if images}
      <form>
        <label class="button">
          Select Images
          <input type="file" accept="image/*,application/pdf" multiple on:input={onFilesSelected} />
        </label>
      </form>
      {#if selected_images.length > 0}
        <div class="uploads">
          {#each selected_images as image (image.url)}
            {#if image.fname}
              Ready to insert "{image.name}" ({numberWithCommas(Math.ceil(image.size / 1024))} KB) as "{image.fname}".
            {:else if image.size != null}
              {window['_user'].uid == 'anonymous' ? 'Processing' : 'Uploading'} "{image.name}" ({numberWithCommas(
                Math.ceil(image.size / 1024)
              )} KB) ...
            {:else}
              {window['_user'].uid == 'anonymous' ? 'Processing' : 'Uploading'} "{image.name}" ...
            {/if}
            <br />
          {/each}
        </div>
      {/if}
    {/if}
    {#if confirm || cancel}
      <div class="buttons">
        {#if cancel}<div class="button cancel" on:mousedown={_onCancel} on:touchend={_onCancel}>{cancel}</div>{/if}
        {#if confirm}
          <div class="button confirm" class:enabled on:mousedown={_onConfirm} on:touchend={_onConfirm}>
            {confirm}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if _visible}
  <script>
    setTimeout(() => {
      document.activeElement?.blur()
      document.querySelector('#modal-input')?.focus()
    })
  </script>
{/if}

<svelte:window on:keydown={onKeyDown} />

<style>
  .background {
    position: fixed;
    z-index: 100;
    top: 0;
    left: 0;
    display: flex;
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
    min-height: 100%;
    background: rgba(17, 17, 17, 0.8);
    visibility: hidden;
  }
  .background.visible {
    visibility: visible;
  }
  .modal {
    height: auto;
    /* width + max-width works best across devices, including android chrome */
    width: 500px;
    max-width: 100%;
    background: #eee;
    border-radius: 5px;
    padding: 20px;
    /* padding-bottom: 30px; */
    color: black;
    font-size: 17px;
    line-height: 24px;
    font-weight: 400;
    word-wrap: break-word; /* same as .item */
  }
  :global(.modal a) {
    color: #79e;
    text-decoration: none;
  }
  input {
    -webkit-appearance: none;
    font-size: 20px;
    border-radius: 4px;
    border: 1px solid #ddd;
    background: white;
    padding: 5px;
    width: 100%;
    box-sizing: border-box;
    margin: 10px 0;
  }
  input[type='file'] {
    display: none;
  }
  label.button {
    margin-left: 0;
    width: 100%;
    box-sizing: border-box;
    margin-top: 15px;
    font-weight: 600;
    font-size: 20px;
  }
  .uploads {
    padding: 10px 0;
    font-size: 16px;
    color: #666;
  }

  .buttons {
    font-size: 20px;
    margin-left: auto;
    width: fit-content;
    padding-top: 15px;
    font-weight: 600;
  }
  .button {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    border-radius: 5px;
    background: #fff;
    border: 1px solid #ddd;
    color: #59f; /* neutral enabled color */
    padding: 10px;
    margin-left: 10px;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .confirm {
    color: #4b4;
  }
  .confirm:hover,
  .confirm:active {
    background: #4b4;
    color: white;
    border-color: white;
  }
  .confirm:not(.enabled) {
    background: #ddd;
    border-color: #ddd;
    color: #999;
    cursor: not-allowed;
  }

  .cancel {
    color: #f55;
  }
  .cancel:hover,
  .cancel:active {
    background: #f55;
    color: white;
    border-color: white;
  }

  /* basic styling for markdown elements, similar to those in Item.svelte */
  :global(.modal code) {
    font-size: 15px; /* 2px smaller looks better */
    font-family: 'JetBrains Mono', monospace;
    font-weight: 400; /* heavier better w/ light modal background */
    background: #ddd;
    white-space: pre-wrap;
    padding: 2px 4px;
    border-radius: 4px;
  }
  :global(.modal > ul, .modal > ol) {
    padding-left: 35px;
    padding-bottom: 5px;
  }
  :global(.modal ul ul, .modal ol ol) {
    padding-left: 20px;
  }
  :global(.modal pre) {
    max-width: 100%;
    max-height: 40vh; /* max 40% of viewport height */
    overflow: scroll;
    background: #222;
    border-radius: 4px;
    word-break: break-all; /* prevent horizontal expansion out of screen bounds */
  }
  :global(.modal pre > code) {
    display: block;
    color: #ddd;
    background: none;
    padding: 2px 5px;
    /* should be smaller than textarea (Editor.svelte) since modal has less width */
    font-size: 12px;
    line-height: 19px;
  }

  @media only screen and (max-width: 600px) {
    :global(.modal pre > code) {
      font-size: 11px;
      line-height: 18px;
    }
  }

  @media only screen and (max-width: 400px) {
    :global(.modal pre > code) {
      font-size: 10px;
      line-height: 17px;
    }
  }
</style>
