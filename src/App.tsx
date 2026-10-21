import { useEffect, useRef, useState } from "react";
import { PAGE_DATA } from "./data.ts";

const { SERVER_URL, EXAMPLE_QUESTIONS, TOOLS, CLIENTS } = PAGE_DATA;

type ClientId = "claude" | "codex" | "opencode";

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 2000);
      }}
      style={copyBtn}
    >
      {copied ? "Skopiowano!" : label ?? "Kopiuj"}
    </button>
  );
}

const copyBtn: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "#c9d1d9",
  padding: "6px 14px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  transition: "all .15s",
  fontFamily: "inherit",
};

const colors = {
  bg: "#0d1117",
  bgAlt: "#161b22",
  card: "#1c232d",
  border: "#30363d",
  text: "#e6edf3",
  textDim: "#8b949e",
  primary: "#388bfd",
  primaryHover: "#4493f8",
  accent: "#2ea043",
  accentHover: "#3fb950",
};

export default function App() {
  const [activeClient, setActiveClient] = useState<ClientId>("claude");
  const client = CLIENTS.find((c) => c.id === activeClient)!;

  return (
    <div style={{ background: colors.bg, color: colors.text, fontFamily: "'Inter', sans-serif", margin: 0, minHeight: "100vh", lineHeight: 1.6 }}>
      {/* Nav */}
      <nav style={{ position: "sticky", top: 0, zIndex: 100, background: "rgba(13,17,23,0.85)", backdropFilter: "blur(12px)", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>PL Stats MCP</span>
          <div style={{ display: "flex", gap: 24, fontSize: 14 }}>
            <a href="#install" style={navLink}>Instalacja</a>
            <a href="#examples" style={navLink}>Przykłady</a>
            <a href="#tools" style={navLink}>Narzędzia</a>
            <a href="#coffee" style={navLink}>Wesprzyj</a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header style={{ padding: "80px 24px 64px", textAlign: "center" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div style={{ display: "inline-block", padding: "6px 14px", borderRadius: 20, background: "rgba(56,139,253,0.12)", border: "1px solid rgba(56,139,253,0.3)", color: colors.primary, fontSize: 13, fontWeight: 500, marginBottom: 24 }}>
            Model Context Protocol · Dane GUS / DBW
          </div>
          <h1 style={{ fontSize: "clamp(28px, 5vw, 44px)", fontWeight: 700, lineHeight: 1.15, margin: "0 0 20px", letterSpacing: "-0.02em" }}>
            Pytaj o polskie statystyki<br />w naturalnym języku
          </h1>
          <p style={{ fontSize: 18, color: colors.textDim, margin: "0 auto 36px", maxWidth: 560 }}>
            Serwer MCP łączący Twoje AI z bazą danych Bank Danych Wojskowych / GUS. Zadawaj pytania — otrzymuj odpowiedzi oparte na rzeczywistych danych.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <a href="#install" style={{ ...btnPrimary, textDecoration: "none", display: "inline-block" }}>Zainstaluj</a>
            <a href="#examples" style={{ ...btnSecondary, textDecoration: "none", display: "inline-block" }}>Zobacz przykłady</a>
          </div>
        </div>
      </header>

      {/* Install */}
      <section id="install" style={{ padding: "64px 24px", borderTop: `1px solid ${colors.border}` }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <h2 style={sectionTitle}>Instalacja</h2>
          <p style={{ ...sectionDesc, marginBottom: 32 }}>
            Wybierz klienta AI, wklej konfigurację i rozpocznij rozmowę. Trwa to mniej niż minutę.
          </p>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 4, marginBottom: 0, borderBottom: `1px solid ${colors.border}`, flexWrap: "wrap" }}>
            {CLIENTS.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveClient(c.id as ClientId)}
                style={activeClient === c.id ? tabActive : tabInactive}
              >
                {c.name}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 32 }}>
            {/* Steps */}
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 16px", color: colors.text }}>Krok po kroku</h3>
              <ol style={{ listStyle: "none", padding: 0, margin: 0, counterReset: "step" }}>
                {client.steps.map((step, i) => (
                  <li key={i} style={{ display: "flex", gap: 12, marginBottom: 14, counterIncrement: "step" }}>
                    <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: "50%", background: colors.primary, color: "#fff", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                      {i + 1}
                    </span>
                    <span style={{ fontSize: 15, color: colors.textDim, lineHeight: 1.5 }}>{step}</span>
                  </li>
                ))}
              </ol>
              <div style={{ marginTop: 20, padding: 14, borderRadius: 8, background: colors.bgAlt, border: `1px solid ${colors.border}` }}>
                <p style={{ fontSize: 13, color: colors.textDim, margin: 0 }}>
                  <strong style={{ color: colors.text }}>Plik konfiguracyjny:</strong><br />
                  <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: colors.textDim, wordBreak: "break-all" }}>
                    {client.filename_mac}
                  </code>
                </p>
              </div>
            </div>

            {/* Config */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: colors.text }}>Konfiguracja</h3>
                <CopyButton text={client.config} />
              </div>
              <pre style={{ ...codeBlock, margin: 0 }}>
                <code>{client.config}</code>
              </pre>
            </div>
          </div>

          {/* DBW key note */}
          <div style={{ marginTop: 32, padding: 18, borderRadius: 10, background: "rgba(46,160,67,0.08)", border: "1px solid rgba(46,160,67,0.25)" }}>
            <p style={{ fontSize: 14, color: colors.textDim, margin: 0 }}>
              <strong style={{ color: colors.accentHover }}>Klucz API DBW (opcjonalny):</strong> Serwer działa bez klucza — korzystasz z współdzielonego limitu zapytań. Dla własnego, większego limitu dodaj nagłówek <code style={inlineCode}>X-DBW-Key</code> z Twoim kluczem API z <a href="https://api.stat.gov.pl" target="_blank" rel="noopener" style={{ color: colors.accentHover }}>api.stat.gov.pl</a>. Pobrane dane są buforowane przez 6 godzin.
            </p>
          </div>
        </div>
      </section>

      {/* Examples */}
      <section id="examples" style={{ padding: "64px 24px", borderTop: `1px solid ${colors.border}`, background: colors.bgAlt }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <h2 style={sectionTitle}>Przykładowe pytania</h2>
          <p style={{ ...sectionDesc, marginBottom: 36 }}>
            Oto pytania, które serwer potrafi obsłużyć — od analizy demograficznej po dostępność mieszkań.
          </p>
          <div style={{ display: "grid", gap: 16 }}>
            {EXAMPLE_QUESTIONS.map((ex, i) => (
              <div key={i} style={{ ...exampleCard }} className="ex-card">
                <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                  <span style={{ fontSize: 22, color: colors.primary, fontWeight: 700, lineHeight: 1, marginTop: 2 }}>„</span>
                  <div>
                    <p style={{ fontSize: 17, color: colors.text, margin: 0, fontWeight: 500, lineHeight: 1.4 }}>{ex.question}</p>
                    <span style={{ display: "inline-block", marginTop: 10, padding: "4px 10px", borderRadius: 4, background: "rgba(56,139,253,0.1)", color: colors.primary, fontSize: 12, fontWeight: 500 }}>
                      {ex.tag}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Tools */}
      <section id="tools" style={{ padding: "64px 24px", borderTop: `1px solid ${colors.border}` }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <h2 style={sectionTitle}>Dostępne narzędzia</h2>
          <p style={{ ...sectionDesc, marginBottom: 36 }}>
            AI korzysta z tych narzędzi automatycznie, gdy odpowiada na Twoje pytania.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
            {TOOLS.map((t) => (
              <div key={t.name} style={{ padding: 20, borderRadius: 10, background: colors.card, border: `1px solid ${colors.border}` }}>
                <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: colors.primary, fontWeight: 500 }}>{t.name}</code>
                <p style={{ fontSize: 14, color: colors.textDim, margin: "8px 0 0", lineHeight: 1.45 }}>{t.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Coffee */}
      <section id="coffee" style={{ padding: "80px 24px", borderTop: `1px solid ${colors.border}`, background: colors.bgAlt, textAlign: "center" }}>
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <h2 style={{ ...sectionTitle, marginBottom: 12 }}>Podoba Ci się?</h2>
          <p style={{ ...sectionDesc, marginBottom: 32 }}>
            Ten projekt jest darmowy i open-source. Jeśli ułatwił Ci pracę — postaw kawę!
          </p>
          <a href="https://buymeacoffee.com/arek_g" target="_blank" rel="noopener" style={{ ...coffeeBtn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 20 }}>☕</span> Postaw kawę
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ padding: "32px 24px", borderTop: `1px solid ${colors.border}`, textAlign: "center" }}>
        <p style={{ fontSize: 13, color: colors.textDim, margin: 0 }}>
          Serwer: <code style={inlineCode}>{SERVER_URL.replace("https://", "")}</code>
        </p>
        <p style={{ fontSize: 13, color: colors.textDim, margin: "8px 0 0" }}>
          Dane: GUS / Bank Danych Wojskowych · Projekt open-source
        </p>
      </footer>
    </div>
  );
}

// --- Styles ---
const navLink: React.CSSProperties = { color: colors.textDim, textDecoration: "none", fontWeight: 500, transition: "color .15s" };
const btnPrimary: React.CSSProperties = { background: colors.primary, color: "#fff", padding: "12px 28px", borderRadius: 8, fontSize: 16, fontWeight: 600, transition: "background .15s" };
const btnSecondary: React.CSSProperties = { background: "rgba(255,255,255,0.06)", border: `1px solid ${colors.border}`, color: colors.text, padding: "12px 28px", borderRadius: 8, fontSize: 16, fontWeight: 600, transition: "all .15s" };
const sectionTitle: React.CSSProperties = { fontSize: "clamp(24px, 4vw, 32px)", fontWeight: 700, textAlign: "center", margin: "0 0 12px", letterSpacing: "-0.01em" };
const sectionDesc: React.CSSProperties = { fontSize: 17, color: colors.textDim, textAlign: "center", maxWidth: 520, margin: "0 auto" };
const codeBlock: React.CSSProperties = { background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 18, fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: colors.text, overflow: "auto", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all" };
const inlineCode: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 13, background: "rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: 4, color: colors.text };
const tabInactive: React.CSSProperties = { background: "transparent", border: "none", color: colors.textDim, padding: "10px 18px", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", borderBottom: "2px solid transparent", transition: "all .15s" };
const tabActive: React.CSSProperties = { ...tabInactive, color: colors.text, borderBottom: `2px solid ${colors.primary}` };
const exampleCard: React.CSSProperties = { padding: "20px 22px", borderRadius: 12, background: colors.card, border: `1px solid ${colors.border}`, transition: "border-color .2s, transform .2s", cursor: "default" };
const coffeeBtn: React.CSSProperties = { background: colors.accent, color: "#fff", padding: "14px 32px", borderRadius: 10, fontSize: 17, fontWeight: 600, transition: "background .15s", border: "none" };

// Tab + button hover effects via injected style tag
const styleSheet = `
  a:hover { color: ${colors.text} !important; }
  .ex-card:hover { border-color: ${colors.primary} !important; transform: translateY(-2px); }
  button:hover { opacity: 0.85; }
  .ex-card, button, a { transition: all .15s ease; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  ::selection { background: ${colors.primary}; color: #fff; }
`;
const styleTag = document.createElement("style");
styleTag.textContent = styleSheet;
document.head.appendChild(styleTag);
