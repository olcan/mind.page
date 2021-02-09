<script lang="ts">
  import { getContext } from "svelte";
  import Alert from "./modals/Alert.svelte";
  import Phrase from "./modals/Phrase.svelte";
  const { open } = getContext("simple-modal");
  const options = {
    // closeOnOuterClick: false,
    closeButton: false,
    styleBg: {
      width: "100%",
      height: "100%", // centers better on iOS
      background: "rgba(0,0,0,.8)", // darker background
    },
    styleWindow: {
      // minHeight: "60px",
    },
    styleContent: {
      fontFamily: "Avenir Next, Helvetica",
      fontWeight: 500,
    },
  };

  let modal = null; // currently displayed modal

  if (typeof window !== "undefined") {
    window["_alert"] = function (
      content: string = "",
      ok_text: string = "Close",
      cancel_text: string = "",
      onClick = null
    ) {
      let ok = true; // default output ("ok") is true (false if cancelled)
      const last_modal = modal;
      return (modal = new Promise((resolve) => {
        Promise.resolve(last_modal).then(() => {
          open(
            Alert,
            {
              content,
              ok_text,
              cancel_text,
              onClick: onClick,
              onCancel: () => {
                ok = false;
              },
            },
            Object.assign(options, {
              closeOnEsc: true,
              closeOnOuterClick: true,
            }),
            { onClosed: () => resolve(ok) }
          );
        });
      }).finally(() => (modal = null)));
    };

    window["_phrase"] = function (content: string = "", done_text: string = "Done", cancel_text: string = "Cancel") {
      let output; // default output is undefined (should be string or null)
      const last_modal = modal;
      return (modal = new Promise((resolve) => {
        Promise.resolve(last_modal).then(() => {
          open(
            Phrase,
            {
              content,
              done_text,
              cancel_text,
              onDone: (phrase) => {
                output = phrase;
              },
              onCancel: () => {
                output = null;
              },
            },
            Object.assign(options, {
              closeOnEsc: false,
              closeOnOuterClick: false,
            }),
            { onClosed: () => resolve(output) }
          );
        });
      }).finally(() => (modal = null)));
    };
  }
</script>
