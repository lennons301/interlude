import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Interlude",
    short_name: "Interlude",
    description: "Agent-first development environment",
    start_url: "/",
    display: "standalone",
    // The fleet's dark ground (--fl-ground), now the app's ground everywhere —
    // an installed Interlude opens on the same colour it renders (issue #117).
    background_color: "#100e0c",
    theme_color: "#100e0c",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
