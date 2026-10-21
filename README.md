# TruthLens — upgraded news credibility checker

TruthLens is a Next.js app for checking a headline or public article URL against published fact-check reviews and related web sources. It keeps “no result” separate from “true” and does not claim to be a perfect truth detector.

## Features in this version

- Responsive login and account creation.
- Case-insensitive unique usernames enforced by PostgreSQL.
- Password rule: 8+ characters, uppercase, number, and symbol; bcrypt password hashes.
- Signed HTTP-only session cookie.
- Database-backed rate limits for login, registration, and checks.
- URL validation and guarded article extraction with redirect limits, DNS/IP checks, HTML-only processing, an 8-second timeout, and a 2 MB body limit.
- Article title/text extraction using Mozilla Readability.
- Google Fact Check Tools API lookup.
- Optional Brave Search API for related source links (context only, not a verdict).
- Per-account recent-check history with delete support.
- Security response headers.
- Server-side secrets and Supabase row-level security.

## Important limitations

- A fact-check database is not exhaustive. A missing result does not prove a story true or false.
- Published ratings apply to specific claims and contexts, not necessarily the whole article.
- Brave Search results are leads to investigate, not evidence of truth by themselves.
- URL extraction is best-effort. Paywalls, dynamic pages, bot protection, and non-HTML pages may prevent extraction.
- URL fetching uses defensive SSRF checks, but no generic URL-fetching implementation can guarantee protection against every DNS rebinding or infrastructure edge case. For a high-risk public deployment, use an isolated extraction service with network egress controls.
- This project does not yet include email-based password recovery, email verification, CAPTCHA, or an operational monitoring service. These require email/anti-bot/monitoring provider setup and should be completed before a public production launch.

## 1. Database setup

1. Create a project at [Supabase](https://supabase.com/).
2. Open **SQL Editor**.
3. Run the complete `supabase/schema.sql` file. If an earlier schema was already applied, run the full updated script again; it uses `IF NOT EXISTS` for the added tables and replaces the rate-limit function.
4. In Supabase Project Settings → API, copy the project URL and service-role key.

The service-role key bypasses RLS and must remain server-side. Never prefix it with `NEXT_PUBLIC_`.

## 2. API keys

### Required for account and history features
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`

Generate a session secret with:

```bash
openssl rand -base64 48
```

### Recommended for published fact-check reviews
Create a Google Cloud project, enable **Fact Check Tools API**, and generate a restricted API key:
https://console.cloud.google.com/

Set `GOOGLE_FACTCHECK_API_KEY`.

### Optional for related web results
Create a Brave Search API subscription/key and set `BRAVE_SEARCH_API_KEY`. Results are presented as related sources, not an automatic truth verdict.

## 3. Local setup

Use Node.js 20 or later.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill `.env.local` with real values:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SESSION_SECRET=your-long-random-secret
GOOGLE_FACTCHECK_API_KEY=your-google-fact-check-api-key
BRAVE_SEARCH_API_KEY=your-brave-search-api-key
```

Open http://localhost:3000.

## 4. Deploy via GitHub and Vercel

1. Push the project to your GitHub repository/branch.
2. Import that repository at https://vercel.com/new.
3. Add all required environment variables in Vercel → Project Settings → Environment Variables.
4. Deploy and use the Vercel URL as your public website link.

Never commit `.env.local` or real keys. The ZIP contains `.env.example` only.

## 5. Existing repository update

To use these upgraded files with your existing branch `brnch_new`:

1. Download and extract this project ZIP.
2. Back up or commit your current branch first.
3. Copy the contents of the extracted project into your repository working tree, preserving the folder structure.
4. Review `git diff` before committing.
5. Run `npm install`, `npm run build`, and test registration, login, checking, history, and logout.
6. Commit and push to `brnch_new`; deploy the branch in Vercel if it is configured as a deployment branch.

Example commands from your existing repository folder after copying files:

```bash
npm install
npm run build
git status
git diff
git add .
git commit -m "Upgrade TruthLens verification and security"
git push origin brnch_new
```

Do not overwrite your branch without a backup and a review of `git diff`.

## Database tables

- `app_users`: username and bcrypt password hash.
- `check_history`: per-user checks and result JSON.
- `rate_limit_buckets`: database-backed request throttling.
- `consume_rate_limit`: atomic SQL function used by server routes.

## Before a production launch

- Add email verification and password recovery.
- Add CAPTCHA/anti-bot after repeated failures.
- Add monitoring, alerts, backup verification, and a privacy policy.
- Review SSRF protections and consider isolated extraction with outbound network controls.
- Add automated tests and run a security review.
- Set API usage budgets/quotas and rotate keys periodically.
