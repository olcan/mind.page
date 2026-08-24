import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  onwarn: (warning, handler) => {
    // as in the sapper-era rollup.config.js; codes are normalized since svelte 5 renamed them
    // from hyphens to underscores (which un-silenced these and flooded the dev terminal)
    const code = warning.code.replace(/-/g, '_')
    if (
      code == 'a11y_click_events_have_key_events' ||
      code == 'a11y_no_static_element_interactions' ||
      code == 'a11y_no_noninteractive_element_interactions'
    )
      return
    handler(warning)
  },
  kit: {
    adapter: adapter(),
  },
}
