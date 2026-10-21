import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const { data: user, error: userError } = await supabase.from("app_users").select("id").eq("username", session.username).maybeSingle();
  if (userError || !user) return NextResponse.json({ error: "Could not load account history." }, { status: 500 });
  const { data, error } = await supabase.from("check_history")
    .select("id,input,status,verdict,created_at,result")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
  if (error) {
    console.error("History read error:", error.message);
    return NextResponse.json({ error: "Could not load history. Confirm the latest database schema has been applied." }, { status: 500 });
  }
  return NextResponse.json({ items: data ?? [] });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid history item." }, { status: 400 });
  const { data: user } = await supabase.from("app_users").select("id").eq("username", session.username).maybeSingle();
  if (!user) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  const { error } = await supabase.from("check_history").delete().eq("id", id).eq("user_id", user.id);
  if (error) return NextResponse.json({ error: "Could not delete history item." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
