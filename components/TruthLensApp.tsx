"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, Search, Link2, Newspaper, LogOut, ArrowUpRight, CircleHelp, CheckCircle2, AlertTriangle, LockKeyhole, Sparkles, ScanSearch, History, Trash2, X } from "lucide-react";

type Check = { claim: string; claimant: string; publisher: string; rating: string; title: string; url: string; date: string };
type Result = { status: string; verdict: string; summary: string; checks: Check[]; evidence?: { title: string; url: string; description: string; age?: string; source: string }[]; input: string; isUrl: boolean; error?: string; article?: { url: string; title: string; text: string; site: string } | null; extractionNote?: string | null };
type HistoryItem = { id: number; input: string; status: string; verdict: string; created_at: string; result: Result };

export default function TruthLensApp({ initialUsername }: { initialUsername: string | null }) {
  const [username, setUsername] = useState(initialUsername);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [authUsername, setAuthUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [input, setInput] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [checking, setChecking] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyError, setHistoryError] = useState("");

  async function loadHistory() {
    try {
      const response = await fetch("/api/history", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load history.");
      setHistory(data.items ?? []);
      setHistoryError("");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load history.");
    }
  }

  useEffect(() => {
    if (username) void loadHistory();
  }, [username]);

  async function deleteHistory(id: number) {
    try {
      const response = await fetch("/api/history", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not delete history item.");
      setHistory(items => items.filter(item => item.id !== id));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not delete history item.");
    }
  }

  async function authenticate(e: React.FormEvent) {
    e.preventDefault(); setAuthError(""); setAuthBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: authUsername.trim(), password }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Authentication failed.");
      setUsername(data.username); setPassword(""); setAuthUsername("");
    } catch (err) { setAuthError(err instanceof Error ? err.message : "Something went wrong."); }
    finally { setAuthBusy(false); }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUsername(null); setResult(null); setInput(""); setMode("login"); setHistory([]); setHistoryOpen(false);
  }

  async function checkNews(e: React.FormEvent) {
    e.preventDefault(); setChecking(true); setResult(null);
    try {
      const res = await fetch("/api/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not check this input.");
      setResult(data);
      void loadHistory();
    } catch (err) { setResult({ status: "error", verdict: "Check could not be completed", summary: err instanceof Error ? err.message : "Please try again.", checks: [], input, isUrl: false }); }
    finally { setChecking(false); }
  }

  if (!username) return (
    <main className="auth-layout">
      <section className="auth-visual">
        <div className="brand"><span className="brand-icon"><ShieldCheck size={22}/></span> truthlens<span className="brand-dot">.</span></div>
        <div className="visual-copy">
          <div className="eyebrow"><Sparkles size={14}/> CLARITY IN A NOISY WORLD</div>
          <h1>Look closer.<br/><em>Know better.</em></h1>
          <p>Check headlines and links against published fact-checks. Make room for evidence before you share.</p>
          <div className="visual-stats"><div><strong>01</strong><span>Search claims</span></div><div><strong>02</strong><span>Review evidence</span></div><div><strong>03</strong><span>Think critically</span></div></div>
        </div>
        <div className="visual-footer"><span>INDEPENDENT THINKING STARTS HERE</span><span>BUILT FOR A MORE INFORMED WEB</span></div>
      </section>
      <section className="auth-panel">
        <div className="mobile-brand"><ShieldCheck size={23}/> truthlens<span>.</span></div>
        <div className="auth-card">
          <div className="auth-icon"><LockKeyhole size={22}/></div>
          <div className="eyebrow muted">{mode === "login" ? "WELCOME BACK" : "YOUR ACCOUNT, YOUR LENS"}</div>
          <h2>{mode === "login" ? "Sign in to TruthLens" : "Create your account"}</h2>
          <p className="subheading">{mode === "login" ? "Your next fact-check is one step away." : "Join a more thoughtful news community."}</p>
          <form onSubmit={authenticate} className="auth-form">
            <label htmlFor="username">Username</label>
            <input id="username" autoComplete="username" value={authUsername} onChange={e => setAuthUsername(e.target.value)} placeholder="e.g. alex_reader" required minLength={3} maxLength={24}/>
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required minLength={8}/>
            {mode === "register" && <div className="password-hint">At least 8 characters, one uppercase letter, one number, and one symbol.</div>}
            {authError && <div className="error-message" role="alert">{authError}</div>}
            <button className="primary-button" disabled={authBusy}>{authBusy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"} <ArrowUpRight size={17}/></button>
          </form>
          <div className="switch-mode">{mode === "login" ? "New to TruthLens?" : "Already have an account?"} <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setAuthError(""); }}>{mode === "login" ? "Create an account" : "Sign in"}</button></div>
          <div className="secure-note"><LockKeyhole size={13}/> Passwords are hashed before storage.</div>
        </div>
        <div className="auth-legal">By continuing, use TruthLens as a research aid—not a final authority.</div>
      </section>
    </main>
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand dark-brand" href="#"><span className="brand-icon"><ShieldCheck size={21}/></span> truthlens<span className="brand-dot">.</span></a>
        <nav><a href="#how-it-works">How it works</a><a href="#methodology">Our approach</a></nav>
        <div className="header-actions"><button className="history-toggle" onClick={() => { setHistoryOpen(open => !open); if (!historyOpen) void loadHistory(); }}><History size={16}/> History <span>{history.length}</span></button><div className="user-menu"><div className="avatar">{username.slice(0,1).toUpperCase()}</div><span>{username}</span><button className="logout-button" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={17}/></button></div></div>
      </header>
      {historyOpen && <section className="history-panel" aria-label="Your recent checks"><div className="history-panel-heading"><div><div className="section-kicker">YOUR ACTIVITY</div><h2>Recent checks</h2></div><button className="history-close" onClick={() => setHistoryOpen(false)} aria-label="Close history"><X size={18}/></button></div>{historyError && <p className="history-error">{historyError}</p>}{history.length === 0 && !historyError && <p className="history-empty">Your checks will appear here after you verify a headline or URL.</p>}<div className="history-list">{history.map(item => <div className="history-entry" key={item.id}><button className="history-entry-main" onClick={() => { setInput(item.input); setHistoryOpen(false); setResult(item.result); }}><strong>{item.verdict}</strong><span>{item.input}</span><small>{new Date(item.created_at).toLocaleString()}</small></button><button className="history-delete" onClick={() => void deleteHistory(item.id)} aria-label="Delete history item" title="Delete"><Trash2 size={15}/></button></div>)}</div></section>}
      <section className="hero">
        <div className="hero-badge"><span className="pulse-dot"></span> EVIDENCE FIRST. ALWAYS.</div>
        <h1>Pause the scroll.<br/><span>Check the story.</span></h1>
        <p className="hero-description">A headline can travel fast. Truth deserves a closer look. Search a news headline or paste an article URL to find published fact-checks.</p>
        <form className="search-card" onSubmit={checkNews}>
          <div className="search-card-top"><div className="search-label"><ScanSearch size={17}/> CHECK A NEWS CLAIM</div><span className="input-count">{input.length}/1000</span></div>
          <div className="input-wrap"><Search size={20}/><input value={input} onChange={e => { setInput(e.target.value); setResult(null); }} placeholder="Paste a news URL or type a headline…" maxLength={1000} minLength={4} required aria-label="News headline or URL"/><button type="submit" disabled={checking || input.trim().length < 4}>{checking ? "Checking…" : "Check story"} <ArrowUpRight size={17}/></button></div>
          <div className="search-card-bottom"><span><LockKeyhole size={13}/> Your search is processed securely</span><span><Link2 size={13}/> Headline or URL accepted</span></div>
        </form>
        {result && <section className={`result-card ${result.status === "error" ? "result-error" : ""}`} aria-live="polite">
          <div className="result-heading"><div className={`result-symbol ${result.status === "reviews_found" ? "symbol-found" : ""}`}>{result.status === "reviews_found" ? <CheckCircle2 size={22}/> : result.status === "error" ? <AlertTriangle size={22}/> : <CircleHelp size={22}/>}</div><div><div className="eyebrow muted">YOUR CHECK RESULTS</div><h2>{result.verdict}</h2></div></div>
          <p className="result-summary">{result.summary}</p>
          {result.checks.length > 0 && <div className="fact-list">{result.checks.map((check, i) => <article className="fact-item" key={`${check.url}-${i}`}><div className="fact-meta"><span className="publisher">{check.publisher}</span>{check.date && <span>{check.date}</span>}</div><h3>{check.title}</h3><p className="claim-text">“{check.claim}”</p><div className="rating-row"><span className="rating-label">Review rating</span><strong>{check.rating}</strong></div>{check.url && <a className="source-link" href={check.url} target="_blank" rel="noreferrer">Read original fact-check <ArrowUpRight size={15}/></a>}</article>)}</div>}
          {result.article && <div className="article-extract"><div className="eyebrow muted">ARTICLE EXTRACTED</div><h3>{result.article.title || result.article.site}</h3><p>{result.article.text ? `${result.article.text.slice(0, 520)}${result.article.text.length > 520 ? "…" : ""}` : "The page title was found, but readable article text was not available."}</p><a className="source-link" href={result.article.url} target="_blank" rel="noreferrer">Open original article <ArrowUpRight size={15}/></a></div>}
          {result.extractionNote && <p className="extraction-note">Article extraction note: {result.extractionNote}</p>}
          {result.evidence && result.evidence.length > 0 && <div className="related-evidence"><div className="eyebrow muted">RELATED WEB SOURCES</div><p>These search results may provide context; they are not automatic proof of the claim.</p>{result.evidence.map((item, i) => <article className="evidence-item" key={`${item.url}-${i}`}><div className="fact-meta"><span className="publisher">{item.source}</span>{item.age && <span>{item.age}</span>}</div><h3>{item.title}</h3><p>{item.description}</p><a className="source-link" href={item.url} target="_blank" rel="noreferrer">Open source <ArrowUpRight size={15}/></a></article>)}</div>}
          <div className="disclaimer"><AlertTriangle size={16}/><p><strong>Important:</strong> A fact-check match is not proof that every detail in an article is false or true. No match means “not verified here,” not “true.” Open the sources, check dates and context, and compare independent reporting.</p></div>
        </section>}
        <div className="trust-row"><div><ShieldCheck size={19}/><span><strong>Evidence-led</strong><small>Published reviews, not guesses</small></span></div><div><Newspaper size={19}/><span><strong>Source-aware</strong><small>Open the original fact-check</small></span></div><div><CircleHelp size={19}/><span><strong>Transparent</strong><small>Unknown is not the same as fake</small></span></div></div>
      </section>
      <section className="how-section" id="how-it-works"><div className="section-kicker">A BETTER WAY TO VERIFY</div><h2>Three steps to a clearer picture.</h2><div className="steps-grid"><article><span className="step-number">01</span><div className="step-icon"><Search size={21}/></div><h3>Submit the claim</h3><p>Enter a headline or article link you want to investigate.</p></article><article><span className="step-number">02</span><div className="step-icon"><ScanSearch size={21}/></div><h3>Find published reviews</h3><p>Search available fact-check databases for claims and ratings.</p></article><article><span className="step-number">03</span><div className="step-icon"><BookOpenIcon/></div><h3>Read the evidence</h3><p>Open the original publisher's review and assess the context.</p></article></div></section>
      <section className="method-section" id="methodology"><div className="method-icon"><ShieldCheck size={25}/></div><div><div className="section-kicker">OUR PROMISE</div><h2>We don't pretend to know what we can't prove.</h2><p>TruthLens surfaces published fact-checks where available. It is not a universal truth detector and does not independently verify every statement on the internet. Always review the source, evidence, publication date, and context before making a decision.</p></div></section>
      <footer className="footer"><a className="brand dark-brand" href="#"><span className="brand-icon"><ShieldCheck size={18}/></span> truthlens<span className="brand-dot">.</span></a><span>Think critically. Share responsibly.</span><span>© {new Date().getFullYear()} TruthLens</span></footer>
    </main>
  );
}

function BookOpenIcon() { return <Newspaper size={21}/>; }