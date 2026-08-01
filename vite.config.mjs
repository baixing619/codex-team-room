import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codexBridgePlugin } from "./server/viteCodexBridge.mjs";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: process.env.TEAM_ROOM_HOST || "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [codexBridgePlugin(), react()],
});
