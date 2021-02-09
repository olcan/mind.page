<script lang="ts">
  export let content;
  export let ok_text = "Close";
  export let cancel_text = "";
  export let onCancel = () => {};
  export let onClick = null;
  import { getContext } from "svelte";
  const { close } = getContext("simple-modal");

  function onKeyDown(e: KeyboardEvent) {
    if (e.code == "Enter") close();
  }
</script>

{@html content}

<div class="buttons">
  {#if cancel_text}
    <div
      class="button cancel"
      on:click={() => {
        if (onClick) onClick(false);
        onCancel();
        close();
      }}
    >
      {cancel_text}
    </div>
  {/if}
  <div
    class="button"
    on:click={() => {
      if (onClick) onClick(true);
      close();
    }}
  >
    {ok_text}
  </div>
</div>

<svelte:window on:keydown={onKeyDown} />

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
  .button:hover {
    border-color: transparent;
    background: #eee;
  }
  .button:active {
    border-color: transparent;
    background: #333;
  }
</style>
