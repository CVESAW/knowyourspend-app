// Origins allowed to call the KnowYourSpend functions from a browser. The phone apps send no Origin.
export const ALLOWED_ORIGINS = new Set([
  "https://knowyourspend-app.vercel.app",
  "https://knowyourspend.vercel.app",
  "https://knowyourspend.org",
  "https://www.knowyourspend.org",
  "https://app.knowyourspend.org",
  "http://localhost:8081",
  "http://localhost:3000",
]);

export function cors(origin: string | null, methods = "POST, OPTIONS"): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function json(status: number, body: unknown, origin: string | null, methods?: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin, methods), "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
