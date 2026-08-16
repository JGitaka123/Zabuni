import type { NextConfig } from "next";

import { resolvePublicApiOrigin } from "./lib/public-config";

resolvePublicApiOrigin(
  process.env.NEXT_PUBLIC_API_URL,
  process.env.NODE_ENV === "production"
);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  headers: () =>
    Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" }
        ]
      }
    ])
};

export default nextConfig;
