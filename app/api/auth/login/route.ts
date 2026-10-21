import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/supabase";
import { createSession } from "@/lib/session";
import { cleanUsername } from "@/lib/validation";
import { accountRateKey, enforceRateLimit, requestKey } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const usernameForLimit = cleanUsername(body.username) || "anonymous";
    const ipAllowed = await enforceRateLimit(`login-ip:${await requestKey(request, "all")}`, 30, 300);
    const accountAllowed = await enforceRateLimit(`login-account:${accountRateKey("login", usernameForLimit)}`, 8, 300);
    if (!ipAllowed || !accountAllowed) return NextResponse.json({ error: "Too many sign-in attempts. Please wait five minutes and try again." }, { status: 429 });
    const username = cleanUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) return NextResponse.json({ error: "Enter your username and password." }, { status: 400 });
    const { data, error } = await supabase.from("app_users").select("username,password_hash").eq("username", username).maybeSingle();
    if (error) throw error;
    if (!data || !(await bcrypt.compare(password, data.password_hash))) {
      return NextResponse.json({ error: "Incorrect username or password." }, { status: 401 });
    }
    await createSession(data.username);
    return NextResponse.json({ username: data.username });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Could not sign in. Please try again." }, { status: 500 });
  }
}