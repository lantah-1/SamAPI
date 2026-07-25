import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.SAMAPI_PORT || "8788";
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    plugins: [react()],
    base: "./",
    server: {
      port: 5173,
      proxy: {
        "/api": apiTarget,
        "/proxy": apiTarget
      }
    }
  };
});
