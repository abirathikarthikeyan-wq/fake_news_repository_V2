import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/supabase";
import { createSession } from "@/lib/session";
import { cleanUsername, validPassword, validUsername } from "@/lib/validation";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const allowed = await enforceRateLimit(`register:${await requestKey(request, "registration")}`, 5, 3600);
    if (!allowed) return NextResponse.json({ error: "Too many registration attempts. Please try again later." }, { status: 429 });
    const username = cleanUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    if (!validUsername(username)) return NextResponse.json({ error: "Username must be 3–24 characters and contain only letters, numbers, or underscores." }, { status: 400 });
    if (!validPassword(password)) return NextResponse.json({ error: "Password must be at least 8 characters and include an uppercase letter, a number, and a symbol." }, { status: 400 });

    const password_hash = await bcrypt.hash(password, 12);
    const { error } = await supabase.from("app_users").insert({ username, password_hash });
    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "That username is already taken. Please choose another." }, { status: 409 });
      console.error("Registration database error:", error.message);
      return NextResponse.json({ error: "Could not create account. Please try again." }, { status: 500 });
    }
    await createSession(username);
    return NextResponse.json({ username });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json({ error: "Server configuration error. Check environment variables." }, { status: 500 });
  }
}