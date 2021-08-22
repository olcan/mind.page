<script lang="ts">
  import marked from "marked";
  import { numberWithCommas } from "../util.js";
  export let onPastedImage = (url: string, file: File, size_handler = null) => {};

  let content = "";
  let confirm = "";
  let cancel = "";
  let input = null;
  let password = false;
  let username = "";
  let autocomplete = "";
  let images = false;
  let canConfirm = (input: string) => input.length > 0;
  let onConfirm = (input = null) => {};
  let onCancel = () => {};
  let background = ""; // can be "confirm" or "cancel", default (empty) is to block, or hide if no confirm/cancel buttons

  let selected_images = []; // used internally for file input
  let ready_image_count = 0;
  let visible = false;
  let enabled = false;
  $: enabled =
    (input == null || canConfirm(input)) &&
    (!images || (selected_images.length > 0 && ready_image_count == selected_images.length));

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
  };

  let inputelem: HTMLInputElement;
  let _promise, _resolve;
  let dispatchTime;
  export function show(options) {
    const last_promise = _promise;
    return (_promise = new Promise((resolve) => {
      _resolve = resolve;
      dispatchTime = Date.now();
      Promise.resolve(last_promise).then(() => {
        ({
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
        } = Object.assign({ ...defaults }, options));
        // console.debug(options, confirm, cancel);
        selected_images = [];
        ready_image_count = 0;
        visible = true;

        // hacky "fix" for Chrome autofill onchange bug https://stackoverflow.com/a/62199697
        // chrome fails to trigger onchange and enable confirm button despite autofill
        if (input != null && autocomplete) {
          const origDispatchTime = dispatchTime;
          const checkForChromeAutofill = () => {
            if (!visible || dispatchTime != origDispatchTime) return; // cancel
            if (inputelem?.matches(":-internal-autofill-selected")) {
              input = inputelem.value; // did not work in experiments but just in case
              enabled = true;
            }
            setTimeout(checkForChromeAutofill, 100);
          };
          checkForChromeAutofill(); // start checking
        }
      });
    }).finally(() => (_promise = null)));
  }

  export function update(options) {
    content = options.content;
  }

  export function hide() {
    visible = false;
    if (_resolve) _resolve();
    return Promise.resolve(_promise);
  }

  export function isVisible() {
    return visible;
  }

  function _onConfirm(e = null) {
    e?.stopPropagation();
    e?.preventDefault();
    if (!enabled) return;
    visible = false;
    const out = images ? selected_images : input != null ? input : true;
    onConfirm(out);
    _resolve(out);
  }

  function _onCancel(e = null) {
    e?.stopPropagation();
    e?.preventDefault();
    if (!cancel) return;
    visible = false;
    const out = images ? [] : input != null ? null : false;
    onCancel();
    _resolve(out);
  }

  function onBackgroundClick(e = null) {
    if (e && (e.target as HTMLElement).closest(".modal")) return; // ignore click on modal
    e?.stopPropagation();
    e?.preventDefault();
    if (!confirm && !cancel) hide();
    else if (confirm && background.toLowerCase() == "confirm") _onConfirm(e);
    else if (cancel && background.toLowerCase() == "cancel") _onCancel(e);
    // else block
  }

  function onKeyDown(e: KeyboardEvent) {
    const key = e.code || e.key; // for android compatibility
    // NOTE: modal is on top of the page and handles ALL key events
    if (!visible) return; // ignore if not visible

    // always stop Enter and Escape
    // also stop all non-modal non-modifier key events as a modal should
    if (
      key == "Enter" ||
      key == "Escape" ||
      (!(e.target as HTMLElement).closest(".modal") && !e.metaKey && !e.ctrlKey && !e.altKey)
    ) {
      e.stopPropagation();
      e.preventDefault();
    }

    // dispatch to keep modal visible and prevent handling by window onKeyDown (in Index.svelte)
    setTimeout(() => {
      if (key == "Enter") _onConfirm();
      else if (key == "Escape") onBackgroundClick();
    });
  }

  function onFilesSelected(e) {
    let input = e.target as HTMLInputElement;
    selected_images = [];
    ready_image_count = 0;
    Array.from(input.files).map((file, index) => {
      const url = URL.createObjectURL(file);
      let image = {
        url: url,
        name: file.name,
        type: file.type,
        fname: null,
        size: null,
      };
      selected_images.push(image);
      Promise.resolve(
        onPastedImage(url, file, (size) => {
          if (selected_images[index]?.url != url) return; // cancelled
          selected_images[index].size = size;
        })
      ).then((fname) => {
        if (selected_images[index]?.url != url) return; // cancelled
        selected_images[index].fname = fname;
        ready_image_count++;
      });
    });
  }
</script>

<div class="background" class:visible on:click={onBackgroundClick}>
  <div class="modal">
    {#if content}{@html marked(content)}{/if}
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
              {window["_user"].uid == "anonymous" ? "Processing" : "Uploading"} "{image.name}" ({numberWithCommas(
                Math.ceil(image.size / 1024)
              )} KB) ...
            {:else}
              {window["_user"].uid == "anonymous" ? "Processing" : "Uploading"} "{image.name}" ...
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

{#if visible}
  <script>
    setTimeout(() => document.querySelector("#modal-input")?.focus());
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
  input[type="file"] {
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
    font-family: monospace;
    background: #ddd;
    white-space: pre-wrap;
    padding: 2px 4px;
    border-radius: 4px;
  }
</style>
