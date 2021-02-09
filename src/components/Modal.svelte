<script lang="ts">
  let content = "";
  let confirm = "";
  let cancel = "";
  let input = null;
  let password = true;
  let canConfirm = (input: string) => input.length > 0;
  let onConfirm = (input = null) => {};
  let onCancel = () => {};
  let background = ""; // can be "confirm" or "cancel"

  let visible = false;
  let enabled = false;
  $: enabled = input == null || canConfirm(input);

  const defaults = { content, confirm, cancel, input, password, canConfirm, onConfirm, onCancel, background };

  let _promise, _resolve;
  export function show(options) {
    const last_promise = _promise;
    return (_promise = new Promise((resolve) => {
      Promise.resolve(last_promise).then(() => {
        _resolve = resolve;
        ({ content, confirm, cancel, input, password, canConfirm, onConfirm, onCancel, background } = Object.assign(
          { ...defaults },
          options
        ));
        console.debug(options, confirm, cancel);
        visible = true;
      });
    }).finally(() => (_promise = null)));
  }

  import { tick } from "svelte";
  export function hide() {
    visible = false;
    return tick();
  }

  export function isVisible() {
    return visible;
  }

  function _onConfirm() {
    if (!enabled) return;
    hide().then(() => {
      onConfirm(input);
      _resolve(input != null ? input : true);
    });
  }

  function _onCancel() {
    if (!cancel) return;
    hide().then(() => {
      onCancel();
      _resolve(input != null ? null : false);
    });
  }

  function onBackgroundClick() {
    if (background.toLowerCase() == "confirm") _onConfirm();
    else if (background.toLowerCase() == "cancel") _onCancel();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!visible) return;
    if (e.code == "Enter") _onConfirm();
    else if (e.code == "Escape") _onCancel();
    if (e.code == "Enter") {
      e.stopPropagation(); // stop enter propagation
      e.preventDefault();
    }
  }
</script>

{#if visible}
  <div class="background" on:click={onBackgroundClick}>
    <div class="modal">
      {#if content}{@html content}{/if}
      {#if input != null}
        {#if password}
          <input type="password" bind:value={input} on:keydown={onKeyDown} />
        {:else}
          <input bind:value={input} on:keydown={onKeyDown} />
        {/if}
        <script>
          setTimeout(() => document.querySelector(".modal input").focus());
        </script>
      {/if}
      <div class="buttons">
        {#if cancel}<div class="button cancel" on:click={_onCancel}>{cancel}</div>{/if}
        {#if confirm}
          <div class="button confirm" class:enabled on:click={_onConfirm}>
            {confirm}
          </div>
        {/if}
      </div>
    </div>
  </div>
  {#if input == null}
    <script>
      setTimeout(() => document.activeElement?.blur());
    </script>
  {/if}
{/if}

<svelte:window on:keydown={onKeyDown} />

<style>
  .background {
    position: fixed;
    top: 0;
    left: 0;
    display: flex;
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
    min-height: -webkit-fill-available;
    background: rgba(17, 17, 17, 0.8);
  }
  .modal {
    height: auto;
    width: auto;
    max-width: 500px;
    background: #eee;
    border-radius: 5px;
    padding: 20px;
    color: black;
    font-family: Avenir Next, Helvetica;
    font-size: 20px;
    font-weight: 500;
  }
  input {
    -webkit-appearance: none;
    font-size: 24px;
    border-radius: 4px;
    border: 1px solid #ddd;
    background: white;
    padding: 5px;
    width: 100%;
    box-sizing: border-box;
    margin-top: 10px;
  }
  .buttons {
    margin-left: auto;
    width: fit-content;
    padding-top: 15px;
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
    cursor: default;
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
</style>
