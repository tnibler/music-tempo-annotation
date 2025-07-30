import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import UnpluginTypia from "@ryoppippi/unplugin-typia/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), UnpluginTypia({})],
});
