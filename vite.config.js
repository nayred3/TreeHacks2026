import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/fusion": {
        target: "http://127.0.0.1:5051",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/fusion/, "/api"),
      },
    },
  },
});
