/**
 * Resolves the backend API base URL automatically:
 * - Uses process.env.NEXT_PUBLIC_API_BASE_URL if configured.
 * - If running in browser on localhost or 127.0.0.1, defaults to "http://127.0.0.1:8000".
 * - If running on remote HTTPS (e.g. on Render), defaults to "" so requests route through Next.js rewrites proxy, eliminating Mixed Content errors.
 */
export function getApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    if (process.env.NEXT_PUBLIC_API_BASE_URL) {
      return process.env.NEXT_PUBLIC_API_BASE_URL.replace(/\/+$/, "");
    }
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "http://127.0.0.1:8000";
    }
    // Remote host (e.g. Render HTTPS) -> use relative URL so Next.js proxies to backend without Mixed Content
    return "";
  }
  return (process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
}
