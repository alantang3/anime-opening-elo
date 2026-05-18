import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /api requests to the Express backend during dev so the frontend
// can just call relative URLs.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:5174",
      // Socket.IO needs a websocket-upgrade-aware proxy in dev.
      "/socket.io": {
        target: "http://localhost:5174",
        ws: true,
      },
    },
  },
});
