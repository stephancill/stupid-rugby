import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app and worker share the World Rugby client in ../src with the CLI.
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: { fs: { allow: [".."] } },
});
