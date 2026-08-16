const LOCAL_API_ORIGIN = "http://localhost:3001";

export function resolvePublicApiOrigin(
  configured: string | undefined,
  production: boolean
): string {
  const trimmed = configured?.trim();
  let value = trimmed;
  if (value === undefined || value === "") {
    value = production ? undefined : LOCAL_API_ORIGIN;
  }
  if (value === undefined) {
    throw new Error("NEXT_PUBLIC_API_URL is required in production");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_API_URL must be a valid absolute origin");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_API_URL must use http:// or https://");
  }
  if (production && parsed.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_API_URL must use https:// in production");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "NEXT_PUBLIC_API_URL must contain only an origin without credentials, path, query, or hash"
    );
  }
  return parsed.origin;
}

export const apiOrigin = resolvePublicApiOrigin(
  process.env.NEXT_PUBLIC_API_URL,
  process.env.NODE_ENV === "production"
);
