import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

import { apiOrigin } from "./public-config";

export const authClient = createAuthClient({
  baseURL: apiOrigin,
  basePath: "/auth",
  plugins: [emailOTPClient()]
});
