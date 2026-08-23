import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  onwarn: (warning, handler) => {
    // as in the sapper-era rollup.config.js
    if (
      warning.code == 'a11y-click-events-have-key-events' ||
      warning.code == 'a11y-no-static-element-interactions' ||
      warning.code == 'a11y-no-noninteractive-element-interactions'
    )
      return
    handler(warning)
  },
  kit: {
    adapter: adapter(),
  },
}
