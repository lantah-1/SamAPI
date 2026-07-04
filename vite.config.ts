import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.SAMAPI_PORT || "8788";
const apiTarget = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/proxy": apiTarget
    }
  }
});
