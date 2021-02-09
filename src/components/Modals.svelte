<script lang="ts">
  import _ from "lodash";
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
    window["_alert"] = function (content: string = "", close_text: string = "Close", cancel_text: string = "") {
      let output = true; // default output is true (false if cancelled)
      const last_modal = modal;
      return (modal = new Promise((resolve) => {
        Promise.resolve(last_modal).then(() => {
          open(
            Alert,
            { content, close_text, cancel_text },
            _.merge(options, {
              closeOnEsc: true,
              closeOnOuterClick: true,
              onCancel: () => {
                output = false;
              },
            }),
            { onClosed: () => resolve(output) }
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
            _.merge(options, {
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
