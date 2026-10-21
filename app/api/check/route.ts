import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { getSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import {
  accountRateKey,
  enforceRateLimit,
  requestKey,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 20;

type Evidence = {
  title: string;
  url: string;
  description: string;
  age?: string;
  source: string;
};

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (url.port && !["80", "443"].includes(url.port)) return null;
    return url;
  } catch {
    return null;
  }
}

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

async function assertPublicHost(url: URL) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Local or private URLs cannot be checked.");
  }

  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) {
      throw new Error("Private or reserved IP addresses are not allowed.");
    }
    return;
  }

  const records = await lookup(host, { all: true, verbatim: true });

  if (
    !records.length ||
    records.some((record) => !isPublicAddress(record.address))
  ) {
    throw new Error(
      "The URL host does not resolve exclusively to public IP addresses."
    );
  }
}

async function extractArticle(
  rawUrl: string
): Promise<{
  finalUrl: string;
  title: string;
  text: string;
  site: string;
} | null> {
  let current = parseHttpUrl(rawUrl);

  if (!current) {
    throw new Error("Enter a valid http:// or https:// article URL.");
  }

  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertPublicHost(current);

    const response = await fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "TruthLensBot/1.0 (news credibility research)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) return null;

      const next = parseHttpUrl(new URL(location, current).toString());
      if (!next) {
        throw new Error("Article redirected to an unsupported URL.");
      }

      current = next;
      continue;
    }

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/html")) return null;

    const contentLength = Number(
      response.headers.get("content-length") || "0"
    );
    if (contentLength > 2_000_000 || !response.body) return null;

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;

      if (total > 2_000_000) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const html = new TextDecoder("utf-8").decode(bytes);
    const dom = new JSDOM(html, { url: current.toString() });
    const document = dom.window.document;

    const metaTitle = document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content")
      ?.trim();

    const fallbackTitle = document.title?.trim();
    const parsed = new Readability(document).parse();

    const title = (
      parsed?.title ||
      metaTitle ||
      fallbackTitle ||
      ""
    )
      .trim()
      .slice(0, 300);

    const text = (
      parsed?.textContent ||
      document
        .querySelector('meta[name="description"]')
        ?.getAttribute("content") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12000);

    dom.window.close();

    if (!title && !text) return null;

    return {
      finalUrl: current.toString(),
      title,
      text,
      site: current.hostname,
    };
  }

  return null;
}

// Common grammatical words are ignored.
// Numbers and negations are kept because they can change claim meaning.
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been",
  "being", "to", "of", "in", "on", "at", "for", "from", "by",
  "with", "as", "and", "or", "but", "it", "its", "this", "that",
  "these", "those", "has", "have", "had", "will", "would", "can",
  "could", "may", "might", "about", "after", "before", "over",
  "under", "into", "than", "then", "who", "what", "when", "where",
  "why", "how",
]);

function claimTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter(
          (token) => token.length > 1 && !STOP_WORDS.has(token)
        )
    ),
  ];
}

// Reject a result if it matches only one or two generic words.
// Short claims require all meaningful terms; longer headlines need
// high keyword coverage in both the title and the title/preview combined.
function matchesWholeClaim(claim: string, result: Evidence): boolean {
  const expected = claimTokens(claim);

  if (expected.length === 0) return false;

  const titleTokens = new Set(claimTokens(result.title));
  const combinedTokens = new Set(
    claimTokens(`${result.title} ${result.description}`)
  );

  const titleCoverage =
    expected.filter((token) => titleTokens.has(token)).length /
    expected.length;

  const combinedCoverage =
    expected.filter((token) => combinedTokens.has(token)).length /
    expected.length;

  const combinedThreshold = expected.length <= 5 ? 1 : 0.85;
  const titleThreshold = expected.length <= 5 ? 1 : 0.65;

  return (
    combinedCoverage >= combinedThreshold &&
    titleCoverage >= titleThreshold
  );
}

async function searchLangSearch(query: string): Promise<Evidence[]> {
  const key = process.env.LANGSEARCH_API_KEY;

  if (!key || !query.trim()) return [];

  try {
    // Search using the complete submitted headline.
    const exactQuery = `"${query
      .replace(/["\r\n]/g, " ")
      .slice(0, 780)}"`;

    const response = await fetch(
      "https://api.langsearch.com/v1/web-search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          query: exactQuery,
          count: 10,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      console.error("LangSearch API returned status", response.status);
      return [];
    }

    const payload = await response.json();

    if (String(payload.code) !== "200") {
      console.error(
        "LangSearch API error:",
        payload.message ?? "Unknown error"
      );
      return [];
    }

    const pages = payload.data?.webPages?.value ?? [];

    const candidates: Evidence[] = pages
      .slice(0, 10)
      .map((item: any) => ({
        title: String(item.name ?? "Search result").slice(0, 300),
        url: String(item.url ?? ""),
        description: String(
          item.snippet ?? item.text ?? "No preview available."
        ).slice(0, 700),
        age:
          typeof item.datePublished === "string"
            ? item.datePublished
            : undefined,
        source: "LangSearch",
      }))
      .filter((item: Evidence) => {
        try {
          return ["http:", "https:"].includes(
            new URL(item.url).protocol
          );
        } catch {
          return false;
        }
      });

    // Only keep results matching most of the complete claim.
    return candidates
      .filter((item) => matchesWholeClaim(query, item))
      .slice(0, 5);
  } catch (error) {
    console.error(
      "LangSearch request failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return [];
  }
}

export async function POST(request: Request) {
  const session = await getSession();

  if (!session) {
    return NextResponse.json(
      { error: "Please sign in to check a claim." },
      { status: 401 }
    );
  }

  try {
    const ipAllowed = await enforceRateLimit(
      `check-ip:${await requestKey(request, "all")}`,
      40,
      60
    );

    const accountAllowed = await enforceRateLimit(
      `check-account:${accountRateKey("check", session.username)}`,
      20,
      60
    );

    if (!ipAllowed || !accountAllowed) {
      return NextResponse.json(
        {
          error:
            "Too many checks in a short period. Please wait a minute and try again.",
        },
        { status: 429 }
      );
    }

    const body = await request.json();
    const input =
      typeof body.input === "string" ? body.input.trim() : "";

    if (input.length < 4 || input.length > 1000) {
      return NextResponse.json(
        {
          error:
            "Enter a headline or URL between 4 and 1,000 characters.",
        },
        { status: 400 }
      );
    }

    const inputUrl = parseHttpUrl(input);
    const isUrl = Boolean(inputUrl);

    let article: {
      finalUrl: string;
      title: string;
      text: string;
      site: string;
    } | null = null;

    let query = input;
    let extractionNote: string | null = null;

    if (isUrl && inputUrl) {
      try {
        article = await extractArticle(input);

        if (article?.title) {
          query = article.title;
        } else {
          query = inputUrl.hostname.replace(/^www\./, "");
        }
      } catch (error) {
        extractionNote =
          error instanceof Error
            ? error.message
            : "Article text could not be extracted safely.";

        query = inputUrl.hostname.replace(/^www\./, "");
      }
    } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) {
      return NextResponse.json(
        {
          error:
            "Only public http:// and https:// URLs are supported.",
        },
        { status: 400 }
      );
    }

    const checks: Array<{
      claim: string;
      claimant: string;
      publisher: string;
      rating: string;
      title: string;
      url: string;
      date: string;
    }> = [];

    const evidence = await searchLangSearch(query);

    const status = evidence.length
      ? "real_sources_found"
      : "fake_no_sources";

    const verdict = evidence.length
      ? "REAL (Sources Found)"
      : "FAKE (No Sources Found)";

    const summary = evidence.length
      ? "Search results closely match the submitted headline or claim. TruthLens labels this REAL (Sources Found) under your selected rule."
      : "No search result matched enough of the submitted headline or claim. TruthLens labels this FAKE (No Sources Found) under your selected rule. No match does not prove a claim is false.";

    const result = {
      status,
      verdict,
      summary,
      checks,
      evidence,
      input,
      isUrl,
      article: article
        ? {
            url: article.finalUrl,
            title: article.title,
            text: article.text,
            site: article.site,
          }
        : null,
      extractionNote,
    };

    const { data: user } = await supabase
      .from("app_users")
      .select("id")
      .eq("username", session.username)
      .maybeSingle();

    if (user?.id) {
      const { error: historyError } = await supabase
        .from("check_history")
        .insert({
          user_id: user.id,
          input,
          status,
          verdict,
          result,
        });

      if (historyError) {
        console.error(
          "Could not save check history:",
          historyError.message
        );
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Check route error:", error);

    const message = error instanceof Error ? error.message : "";

    if (
      /private|reserved|Local or private|public IP|redirected to an unsupported/i.test(
        message
      )
    ) {
      return NextResponse.json(
        { error: message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        error: "Unable to check this input. Please try again.",
      },
      { status: 500 }
    );
  }
}
