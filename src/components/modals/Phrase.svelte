<script lang="ts">
  export let content: string;
  export let cancel_text = "Cancel";
  export let done_text = "Done";
  export let onDone = (phrase: string) => {};
  export let onCancel = () => {};
  let phrase: string = "";
  let phrase_valid: boolean = false;
  $: phrase_valid = phrase.length > 0;

  import { getContext } from "svelte";
  const { close } = getContext("simple-modal");

  function onKeyDown(e: KeyboardEvent) {
    if (e.code == "Enter" && phrase_valid) {
      onDone(phrase);
      close();
    }
    e.stopPropagation();
  }
</script>

{@html content}

<div class="inputs">
  <!-- svelte-ignore a11y-autofocus -->
  <input type="password" id="phrase" bind:value={phrase} on:keydown={onKeyDown} autofocus />
</div>

<div class="buttons">
  <div
    class="button enabled cancel"
    on:click={() => {
      onCancel();
      close();
    }}
  >
    {cancel_text}
  </div>

  <div
    class="button"
    class:enabled={phrase_valid}
    on:click={() => {
      if (phrase_valid) {
        onDone(phrase);
        close();
      }
    }}
  >
    {done_text}
  </div>
</div>

<style>
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
    border: 1px solid #eee;
    color: #4b4;
    padding: 10px;
    margin-left: 10px;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .button.cancel {
    color: #f55;
  }
  .button:not(.enabled) {
    color: gray;
    cursor: default;
  }
  .button.enabled:hover {
    border-color: transparent;
    background: #eee;
  }
  .button.enabled:active {
    border-color: transparent;
    background: #333;
  }
  .inputs {
    display: flex;
    justify-content: center;
    align-items: center;
    margin-top: 10px;
  }
  input {
    -webkit-appearance: none;
    font-size: 24px;
    border-radius: 4px;
    border: 0;
    background: #eee;
    padding: 5px;
    width: 100%;
  }
</style>
