import { createHash } from "node:crypto";
import { supabase } from "@/lib/supabase";

export async function requestKey(request: Request, username: string) {
  // Prefer platform-provided client IP; do not trust arbitrary client-supplied X-Forwarded-For chains.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const identity = `${username.toLowerCase()}:${realIp || forwarded || "unknown"}`;
  return createHash("sha256").update(identity).digest("hex");
}

export function accountRateKey(scope: string, username: string) {
  return createHash("sha256").update(`${scope}:${username.toLowerCase()}`).digest("hex");
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number) {
  const { data, error } = await supabase.rpc("consume_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds
  });
  if (error) {
    // Fail closed: rate limiting should not silently be bypassed if the database function is missing.
    console.error("Rate-limit database error:", error.message);
    throw new Error("Rate limiting is not configured. Run the latest Supabase schema.");
  }
  return data === true;
}
