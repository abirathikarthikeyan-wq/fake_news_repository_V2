import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { getSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import { accountRateKey, enforceRateLimit, requestKey } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 20;

type FactCheck = {
  text?: string;
  claimant?: string;
  claimReview?: Array<{
    publisher?: { name?: string };
    url?: string;
    title?: string;
    textualRating?: string;
    reviewDate?: string;
  }>;
};
type Evidence = { title: string; url: string; description: string; age?: string; source: string };

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (url.port && !["80", "443"].includes(url.port)) return null;
    return url;
  } catch { return null; }
}

function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch { return false; }
}

async function assertPublicHost(url: URL) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Local or private URLs cannot be checked.");
  }
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new Error("Private or reserved IP addresses are not allowed.");
    return;
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new Error("The URL host does not resolve exclusively to public IP addresses.");
  }
}

async function extractArticle(rawUrl: string): Promise<{ finalUrl: string; title: string; text: string; site: string } | null> {
  let current = parseHttpUrl(rawUrl);
  if (!current) throw new Error("Enter a valid http:// or https:// article URL.");
  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertPublicHost(current);
    const response = await fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "TruthLensBot/1.0 (news credibility research)", "Accept": "text/html,application/xhtml+xml" }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) return null;
      const next = parseHttpUrl(new URL(location, current).toString());
      if (!next) throw new Error("Article redirected to an unsupported URL.");
      current = next;
      continue;
    }
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/html")) return null;
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > 2_000_000) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2_000_000) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const html = new TextDecoder("utf-8").decode(bytes);
    const dom = new JSDOM(html, { url: current.toString() });
    const document = dom.window.document;
    const metaTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
    const fallbackTitle = document.title?.trim();
    const parsed = new Readability(document).parse();
    const title = (parsed?.title || metaTitle || fallbackTitle || "").trim().slice(0, 300);
    const text = (parsed?.textContent || document.querySelector('meta[name="description"]')?.getAttribute("content") || "").replace(/\s+/g, " ").trim().slice(0, 12000);
    dom.window.close();
    if (!title && !text) return null;
    return { finalUrl: current.toString(), title, text, site: current.hostname };
  }
  return null;
}

async function searchBrave(query: string): Promise<Evidence[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key || !query) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query.slice(0, 400));
  url.searchParams.set("count", "5");
  const response = await fetch(url, {
    headers: { "Accept": "application/json", "X-Subscription-Token": key },
    cache: "no-store",
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.web?.results ?? []).slice(0, 5).map((item: any) => ({
    title: String(item.title ?? "Search result").slice(0, 300),
    url: String(item.url ?? ""),
    description: String(item.description ?? "").slice(0, 700),
    age: typeof item.age === "string" ? item.age : undefined,
    source: "Brave Search"
  })).filter((item: Evidence) => {
    try { return ["http:", "https:"].includes(new URL(item.url).protocol); } catch { return false; }
  });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Please sign in to check a claim." }, { status: 401 });

  try {
    const ipAllowed = await enforceRateLimit(`check-ip:${await requestKey(request, "all")}`, 40, 60);
    const accountAllowed = await enforceRateLimit(`check-account:${accountRateKey("check", session.username)}`, 20, 60);
    if (!ipAllowed || !accountAllowed) return NextResponse.json({ error: "Too many checks in a short period. Please wait a minute and try again." }, { status: 429 });

    const body = await request.json();
    const input = typeof body.input === "string" ? body.input.trim() : "";
    if (input.length < 4 || input.length > 1000) {
      return NextResponse.json({ error: "Enter a headline or URL between 4 and 1,000 characters." }, { status: 400 });
    }

    const inputUrl = parseHttpUrl(input);
    const isUrl = Boolean(inputUrl);
    let article: { finalUrl: string; title: string; text: string; site: string } | null = null;
    let query = input;
    let extractionNote: string | null = null;
    if (isUrl && inputUrl) {
      try {
        article = await extractArticle(input);
        if (article?.title) query = article.title;
        else query = inputUrl.hostname.replace(/^www\./, "");
      } catch (error) {
        extractionNote = error instanceof Error ? error.message : "Article text could not be extracted safely.";
        query = inputUrl.hostname.replace(/^www\./, "");
      }
    } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) {
      return NextResponse.json({ error: "Only public http:// and https:// URLs are supported." }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_FACTCHECK_API_KEY;
    let checks: Array<{ claim: string; claimant: string; publisher: string; rating: string; title: string; url: string; date: string }> = [];
    let factCheckConfigured = Boolean(apiKey);
    if (apiKey) {
      const endpoint = new URL("https://factchecktools.googleapis.com/v1alpha1/claims:search");
      endpoint.searchParams.set("query", query.slice(0, 500));
      endpoint.searchParams.set("key", apiKey);
      endpoint.searchParams.set("pageSize", "10");
      const response = await fetch(endpoint.toString(), { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        console.error("Fact Check API returned status", response.status);
        if (response.status === 403) {
          return NextResponse.json({ error: "Fact-check API access was denied. Check that the API is enabled and the key is valid." }, { status: 502 });
        }
        if (response.status === 429) return NextResponse.json({ error: "The fact-check service quota has been reached. Try again later." }, { status: 502 });
        return NextResponse.json({ error: "The fact-check service is temporarily unavailable." }, { status: 502 });
      }
      const payload = await response.json();
      const claims: FactCheck[] = payload.claims ?? [];
      checks = claims.flatMap(claim => (claim.claimReview ?? []).map(review => ({
        claim: claim.text ?? "Claim reviewed",
        claimant: claim.claimant ?? "",
        publisher: review.publisher?.name ?? "Fact-check publisher",
        rating: review.textualRating ?? "Rating not provided",
        title: review.title ?? "Read the fact-check",
        url: review.url ?? "",
        date: review.reviewDate ?? ""
      }))).slice(0, 10);
    }

    const evidence = await searchBrave(query);
    let status = "unverified";
    let verdict = "No matching fact-checks found";
    let summary = factCheckConfigured
      ? "No matching published fact-check was returned. This does not mean the story is true or false. Review the available source material and compare independent reporting."
      : "Fact-check lookup is not configured. Add GOOGLE_FACTCHECK_API_KEY to search published reviews. This app will not guess whether a story is true or false.";
    if (checks.length) {
      status = "reviews_found";
      verdict = "Published fact-checks found";
      summary = `Found ${checks.length} published review result(s). Ratings apply to specific claims and context; read the original reviews before deciding what they mean.`;
    } else if (evidence.length) {
      verdict = "Related sources found — claim not yet verified";
      summary = "Search results provide context to investigate, but search-result matches alone do not prove or disprove a claim.";
    }

    const result = {
      status, verdict, summary, checks, evidence,
      input, isUrl, factCheckConfigured,
      article: article ? { url: article.finalUrl, title: article.title, text: article.text, site: article.site } : null,
      extractionNote
    };

    // Save history on the server; history is associated with the authenticated account.
    const { data: user } = await supabase.from("app_users").select("id").eq("username", session.username).maybeSingle();
    if (user?.id) {
      const { error: historyError } = await supabase.from("check_history").insert({
        user_id: user.id, input, status, verdict, result
      });
      if (historyError) console.error("Could not save check history:", historyError.message);
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("Check route error:", error);
    const message = error instanceof Error ? error.message : "";
    if (/private|reserved|Local or private|public IP|redirected to an unsupported/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "Unable to check this input. Please try again." }, { status: 500 });
  }
}
