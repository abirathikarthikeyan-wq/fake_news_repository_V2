
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
export const maxDuration = 30;

type Evidence = {
  title: string;
  url: string;
  description: string;
  age?: string;
  source: string;
};

type EvaluatedEvidence = Evidence & {
  domain: string;
  coverage: number;
  kind: "supporting" | "potentially_contradicting" | "unclear";
};

type Decision = {
  status: "real_corroborated" | "fake_contradicted" | "unverified";
  verdict: string;
  summary: string;
  evidence: EvaluatedEvidence[];
};

type Article = {
  finalUrl: string;
  title: string;
  text: string;
  site: string;
};

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been",
  "being", "to", "of", "in", "on", "at", "for", "from", "by",
  "with", "as", "and", "or", "but", "it", "its", "this", "that",
  "these", "those", "has", "have", "had", "will", "would", "can",
  "could", "may", "might", "about", "after", "before", "over",
  "under", "into", "than", "then", "who", "what", "when", "where",
  "why", "how"
]);

// ------------------------------------------------------
// URL validation
// ------------------------------------------------------

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;

    if (url.port && !["80", "443"].includes(url.port)) {
      return null;
    }

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

async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

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

  const records = await lookup(host, {
    all: true,
    verbatim: true
  });

  if (
    !records.length ||
    records.some(record => !isPublicAddress(record.address))
  ) {
    throw new Error(
      "The URL host does not resolve exclusively to public IP addresses."
    );
  }
}

// ------------------------------------------------------
// Article extraction
// ------------------------------------------------------

async function extractArticle(
  rawUrl: string
): Promise<Article | null> {
  let current = parseHttpUrl(rawUrl);

  if (!current) {
    throw new Error("Enter a valid public HTTP or HTTPS article URL.");
  }

  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertPublicHost(current);

    const response = await fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "TruthLensBot/1.0",
        Accept: "text/html,application/xhtml+xml"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      if (!location || redirects === 3) return null;

      const next = parseHttpUrl(
        new URL(location, current).toString()
      );

      if (!next) {
        throw new Error("Article redirected to an unsupported URL.");
      }

      current = next;
      continue;
    }

    if (!response.ok) return null;

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("text/html")) {
      return null;
    }

    const contentLength = Number(
      response.headers.get("content-length") || "0"
    );

    if (contentLength > 2_000_000 || !response.body) {
      return null;
    }

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
    const dom = new JSDOM(html, {
      url: current.toString()
    });

    const document = dom.window.document;

    const metaTitle = document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content")
      ?.trim();

    const parsed = new Readability(document).parse();

    const title = (
      parsed?.title ||
      metaTitle ||
      document.title ||
      ""
    ).trim().slice(0, 300);

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
      site: current.hostname
    };
  }

  return null;
}

// ------------------------------------------------------
// Text normalization and claim comparison
// ------------------------------------------------------

function tokens(value: string): string[] {
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
          word => word.length > 1 && !STOP_WORDS.has(word)
        )
    )
  ];
}

function getDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isOfficialDomain(domain: string): boolean {
  return (
    domain.endsWith(".gov") ||
    domain.endsWith(".gov.in") ||
    domain.endsWith(".nic.in") ||
    domain.endsWith(".gov.uk") ||
    domain.endsWith(".gov.au")
  );
}

function coverageForClaim(
  claim: string,
  evidence: Evidence
): number {
  const claimWords = tokens(claim);

  if (!claimWords.length) return 0;

  const resultWords = new Set(
    tokens(`${evidence.title} ${evidence.description}`)
  );

  const matched = claimWords.filter(
    word => resultWords.has(word)
  ).length;

  return matched / claimWords.length;
}

// Keep negations, numbers and names in the comparison.
// A source that only shares a few generic words is not enough.
function isRelevantMatch(
  claim: string,
  evidence: Evidence
): boolean {
  const claimWords = tokens(claim);

  if (claimWords.length < 2) return false;

  const titleCoverage = coverageForClaim(claim, {
    ...evidence,
    description: ""
  });

  const combinedCoverage = coverageForClaim(claim, evidence);

  const titleThreshold =
    claimWords.length <= 5 ? 0.8 : 0.5;

  const combinedThreshold =
    claimWords.length <= 5 ? 0.8 : 0.65;

  return (
    titleCoverage >= titleThreshold &&
    combinedCoverage >= combinedThreshold
  );
}

// These phrases may signal a correction or fact-check article.
// They are not proof of a contradiction by themselves.
function hasCorrectionLanguage(text: string): boolean {
  return /\b(
    false claim|
    fact[\s-]?check|
    debunked|
    fabricated|
    hoax|
    misleading claim|
    not true|
    did not happen|
    no evidence that|
    officials denied|
    statement is false|
    claim is false|
    incorrect claim
  )\b/ix.test(text.replace(/\s+/g, " "));
}

// ------------------------------------------------------
// LangSearch: search the full claim and variations
// ------------------------------------------------------

async function searchOneQuery(
  query: string
): Promise<Evidence[]> {
  const apiKey = process.env.LANGSEARCH_API_KEY;

  if (!apiKey) {
    throw new Error("LANGSEARCH_API_KEY is not configured.");
  }

  const response = await fetch(
    "https://api.langsearch.com/v1/web-search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        query: query.slice(0, 800),
        count: 10
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `LangSearch request failed with status ${response.status}.`
    );
  }

  const payload = await response.json();

  if (String(payload.code) !== "200") {
    throw new Error(
      `LangSearch API error: ${payload.message || "Unknown error"}`
    );
  }

  const pages = payload.data?.webPages?.value ?? [];

  return pages.map((item: any) => ({
    title: String(item.name ?? "Search result").slice(0, 300),
    url: String(item.url ?? ""),
    description: String(
      item.snippet ?? item.text ?? ""
    ).slice(0, 1000),
    age:
      typeof item.datePublished === "string"
        ? item.datePublished
        : undefined,
    source: "LangSearch"
  })).filter((item: Evidence) => {
    try {
      const url = new URL(item.url);
      return ["http:", "https:"].includes(url.protocol);
    } catch {
      return false;
    }
  });
}

async function searchLangSearch(
  claim: string
): Promise<Evidence[]> {
  const cleanClaim = claim
    .replace(/["\r\n]+/g, " ")
    .trim();

  const claimWords = tokens(cleanClaim);

  const queries = [
    `"${cleanClaim.slice(0, 700)}"`,
    cleanClaim.slice(0, 700),
    `${claimWords.slice(0, 12).join(" ")} official news`,
    `${cleanClaim.slice(0, 500)} fact check`
  ].filter(
    (query, index, all) =>
      query.length > 0 && all.indexOf(query) === index
  );

  // Continue if an individual query fails, but do not silently
  // treat total API failure as "no sources found".
  const results = await Promise.allSettled(
    queries.map(searchOneQuery)
  );

  const successful = results.filter(
    (
      result
    ): result is PromiseFulfilledResult<Evidence[]> =>
      result.status === "fulfilled"
  );

  if (successful.length === 0) {
    throw new Error("All LangSearch queries failed.");
  }

  const unique = new Map<string, Evidence>();

  for (const result of successful) {
    for (const item of result.value) {
      try {
        const url = new URL(item.url);
        url.hash = "";

        if (!unique.has(url.toString())) {
          unique.set(url.toString(), {
            ...item,
            url: url.toString()
          });
        }
      } catch {
        // Ignore invalid URLs.
      }
    }
  }

  return [...unique.values()].slice(0, 30);
}

// ------------------------------------------------------
// Rule-based evidence evaluation
// ------------------------------------------------------

function evaluateEvidence(
  claim: string,
  sources: Evidence[]
): EvaluatedEvidence[] {
  return sources.map(source => {
    const domain = getDomain(source.url);

    const text = `${source.title} ${source.description}`;
    const coverage = coverageForClaim(claim, source);

    let kind: EvaluatedEvidence["kind"] = "unclear";

    if (
      isRelevantMatch(claim, source) &&
      hasCorrectionLanguage(text)
    ) {
      kind = "potentially_contradicting";
    } else if (isRelevantMatch(claim, source)) {
      kind = "supporting";
    }

    return {
      ...source,
      domain,
      coverage,
      kind
    };
  });
}

function decideVerdict(
  claim: string,
  sources: Evidence[]
): Decision {
  const evaluated = evaluateEvidence(claim, sources);

  const supporting = evaluated.filter(
    item => item.kind === "supporting"
  );

  const contradicting = evaluated.filter(
    item => item.kind === "potentially_contradicting"
  );

  const supportDomains = new Set(
    supporting.map(item => item.domain).filter(Boolean)
  );

  const contradictionDomains = new Set(
    contradicting.map(item => item.domain).filter(Boolean)
  );

  const officialSupport = supporting.some(
    item =>
      isOfficialDomain(item.domain) &&
      item.coverage >= 0.75
  );

  const officialCorrection = contradicting.some(
    item =>
      isOfficialDomain(item.domain) &&
      item.coverage >= 0.75
  );

  // Rule-based correction signals are imperfect. Even an official
  // correction should be presented as evidence to inspect.
  if (
    officialCorrection ||
    (
      contradictionDomains.size >= 2 &&
      contradictionDomains.size > supportDomains.size
    )
  ) {
    return {
      status: "fake_contradicted",
      verdict: "FAKE — Contradicted by Sources",
      summary:
        "Relevant correction language was found. Open the sources and verify that the correction directly contradicts the submitted claim. Keyword rules alone cannot confirm falsity.",
      evidence: evaluated
    };
  }

  if (
    officialSupport ||
    supportDomains.size >= 2
  ) {
    return {
      status: "real_corroborated",
      verdict: "REAL — Corroborated by Sources",
      summary:
        "Multiple domains or a potentially relevant official source match important terms in the claim. Review the linked material to confirm the complete claim and its context.",
      evidence: evaluated
    };
  }

  return {
    status: "unverified",
    verdict: "UNVERIFIED — Insufficient Evidence",
    summary:
      "The available results do not establish whether the claim is true or false. No adequate match is not proof that a claim is fake.",
    evidence: evaluated
  };
}

// ------------------------------------------------------
// API route: authentication, rate limiting, history
// ------------------------------------------------------

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
      `check-account:${accountRateKey(
        "check",
        session.username
      )}`,
      20,
      60
    );

    if (!ipAllowed || !accountAllowed) {
      return NextResponse.json(
        {
          error:
            "Too many checks in a short period. Please wait a minute and try again."
        },
        { status: 429 }
      );
    }

    const body = await request.json();

    const input =
      typeof body.input === "string"
        ? body.input.trim()
        : "";

    if (input.length < 4 || input.length > 1000) {
      return NextResponse.json(
        {
          error:
            "Enter a headline or URL between 4 and 1,000 characters."
        },
        { status: 400 }
      );
    }

    const inputUrl = parseHttpUrl(input);
    const isUrl = Boolean(inputUrl);

    let article: Article | null = null;
    let query = input;
    let extractionNote: string | null = null;

    if (isUrl && inputUrl) {
      try {
        article = await extractArticle(input);

        if (article?.title) {
          // Check the headline plus available article text.
          query = `${article.title} ${article.text.slice(0, 1500)}`;
        } else {
          extractionNote =
            "The article could not be extracted. Searching using the URL is not enough to verify its contents.";
          query = input;
        }
      } catch (error) {
        extractionNote =
          error instanceof Error
            ? error.message
            : "Article extraction failed.";

        return NextResponse.json(
          {
            error:
              "Could not safely retrieve the article. Submit its headline as text instead.",
            extractionNote
          },
          { status: 400 }
        );
      }
    } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) {
      return NextResponse.json(
        {
          error:
            "Only public HTTP and HTTPS URLs are supported."
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

    const searchResults = await searchLangSearch(query);
    const decision = decideVerdict(query, searchResults);

    const status = decision.status;
    const verdict = decision.verdict;
    const summary = decision.summary;
    const evidence = decision.evidence;

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
            site: article.site
          }
        : null,
      extractionNote
    };

    // Save the result for the authenticated user.
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
          result
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

    const message =
      error instanceof Error ? error.message : "";

    if (/LANGSEARCH_API_KEY|LangSearch/.test(message)) {
      return NextResponse.json(
        {
          error:
            "The web-search service is unavailable. Check the LangSearch API configuration and try again."
        },
        { status: 502 }
      );
    }

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
        error:
          "Unable to check this input. Please try again."
      },
      { status: 500 }
    );
  }
}
