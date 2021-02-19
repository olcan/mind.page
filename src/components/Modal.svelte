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
  let background = ""; // can be "confirm" or "cancel" (empty means block)

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
        if (input && autocomplete) {
          const origDispatchTime = dispatchTime;
          const chromeCheckInterval = setInterval(() => {
            if (!visible || dispatchTime != origDispatchTime) {
              clearInterval(chromeCheckInterval);
              return;
            }
            if (inputelem?.matches(":-internal-autofill-selected")) {
              input = inputelem.value; // did not work in experiments but just in case
              enabled = true;
            }
          }, 1000);
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

  function _onConfirm(e) {
    e.stopPropagation();
    e.preventDefault();
    if (!enabled) return;
    visible = false;
    const out = images ? selected_images : input != null ? input : true;
    onConfirm(out);
    _resolve(out);
  }

  function _onCancel(e) {
    e.stopPropagation();
    e.preventDefault();
    if (!cancel) return;
    visible = false;
    const out = images ? [] : input != null ? null : false;
    onCancel();
    _resolve(out);
  }

  function onBackgroundClick(e) {
    e.stopPropagation();
    e.preventDefault();
    if ((e.target as HTMLElement).closest(".modal")) return; // ignore click on modal
    if (background.toLowerCase() == "confirm") _onConfirm(e);
    else if (background.toLowerCase() == "cancel") _onCancel(e);
  }

  function onKeyDown(e: KeyboardEvent) {
    const key = e.code || e.key; // for android compatibility
    if (!visible) return;
    if (key == "Enter") _onConfirm(e);
    else if (key == "Escape") {
      // treat escape like background click
      if (background.toLowerCase() == "confirm") _onConfirm(e);
      else if (background.toLowerCase() == "cancel") _onCancel(e);
    }
    if (key == "Enter") {
      e.stopPropagation(); // stop enter propagation
      e.preventDefault();
    }
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

{#if visible}
  <div class="background" on:click={onBackgroundClick}>
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
        <script>
          setTimeout(() => document.querySelector("#modal-input").focus());
        </script>
      {/if}
      {#if images}
        <form>
          <label class="button">
            Select Images
            <input type="file" accept="image/*" multiple on:input={onFilesSelected} />
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
{/if}

<svelte:window on:keydown={onKeyDown} />

<style>
  .background {
    position: fixed;
    z-index: 10;
    top: 0;
    left: 0;
    display: flex;
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
    min-height: 100%;
    background: rgba(17, 17, 17, 0.8);
  }
  .modal {
    height: auto;
    /* width + max-width works best across devices, including android chrome */
    width: 500px;
    max-width: 100%;
    background: #eee;
    border-radius: 5px;
    padding: 20px;
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
    margin-top: 10px;
  }
  input[type="file"] {
    display: none;
  }
  label.button {
    margin-left: 0;
    width: 100%;
    box-sizing: border-box;
    margin-top: 15px;
    font-weight: 500;
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
    font-weight: 500;
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
    font-family: "Roboto Mono", monospace;
    background: #ddd;
    white-space: pre-wrap;
    padding: 2px 4px;
    border-radius: 4px;
  }
</style>
