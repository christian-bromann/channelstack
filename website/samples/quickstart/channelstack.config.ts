import { defineConfig } from "channelstack";

export default defineConfig({
  slack: {
    app: {
      name: "robin",
      manifest: "./slack-manifest.yaml",
    },
  },
});
