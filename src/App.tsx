import { useEffect, useRef, useState } from "react";
import { PAGE_DATA, type Lang } from "./data.ts";

const { SERVER_URL, EXAMPLE_QUESTIONS, TOOLS, CLIENTS, UI } = PAGE_DATA;

type ClientId = "claude" | "codex" | "opencode";

function CopyButton({ text, lang }: { text: string; lang: Lang }) {
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
      {copied ? (lang === "pl" ? "Skopiowano!" : "Copied!") : (lang === "pl" ? "Kopiuj" : "Copy")}
    </button>
  );
}

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
const docsLink: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, color: colors.primary, fontSize: 14, fontWeight: 500, textDecoration: "none", marginTop: 12, transition: "color .15s" };

export default function App() {
  const [lang, setLang] = useState<Lang>("pl");
  const [activeClient, setActiveClient] = useState<ClientId>("claude");
  const client = CLIENTS.find((c) => c.id === activeClient)!;
  const t = UI[lang];
  const examples = EXAMPLE_QUESTIONS[lang];

  return (
    <div style={{ background: colors.bg, color: colors.text, fontFamily: "'Inter', sans-serif", margin: 0, minHeight: "100vh", lineHeight: 1.6 }}>
      {/* Nav */}
      <nav style={{ position: "sticky", top: 0, zIndex: 100, background: "rgba(13,17,23,0.85)", backdropFilter: "blur(12px)", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>PL Stats MCP</span>
          <div style={{ display: "flex", gap: 24, fontSize: 14, alignItems: "center" }}>
            <a href="#install" style={navLink}>{lang === "pl" ? "Instalacja" : "Install"}</a>
            <a href="#examples" style={navLink}>{lang === "pl" ? "Przykłady" : "Examples"}</a>
            <a href="#tools" style={navLink}>{lang === "pl" ? "Narzędzia" : "Tools"}</a>
            <a href="#coffee" style={navLink}>{lang === "pl" ? "Wesprzyj" : "Support"}</a>
            <button
              onClick={() => setLang(lang === "pl" ? "en" : "pl")}
              style={{
                background: "rgba(255,255,255,0.08)",
                border: `1px solid ${colors.border}`,
                color: colors.text,
                padding: "5px 14px",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "all .15s",
              }}
            >
              {t.langToggle}
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header style={{ padding: "80px 24px 64px", textAlign: "center" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div style={{ display: "inline-block", padding: "6px 14px", borderRadius: 20, background: "rgba(56,139,253,0.12)", border: "1px solid rgba(56,139,253,0.3)", color: colors.primary, fontSize: 13, fontWeight: 500, marginBottom: 24 }}>
            {t.badge}
          </div>
          <h1 style={{ fontSize: "clamp(28px, 5vw, 44px)", fontWeight: 700, lineHeight: 1.15, margin: "0 0 20px", letterSpacing: "-0.02em" }}>
            {t.heroTitle1}<br />{t.heroTitle2}
          </h1>
          <p style={{ fontSize: 18, color: colors.textDim, margin: "0 auto 36px", maxWidth: 560 }}>
            {t.heroDesc}
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <a href="#install" style={{ ...btnPrimary, textDecoration: "none", display: "inline-block" }}>{t.installBtn}</a>
            <a href="#examples" style={{ ...btnSecondary, textDecoration: "none", display: "inline-block" }}>{t.examplesBtn}</a>
          </div>
        </div>
      </header>

      {/* Install */}
      <section id="install" style={{ padding: "64px 24px", borderTop: `1px solid ${colors.border}` }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <h2 style={sectionTitle}>{t.installTitle}</h2>
          <p style={{ ...sectionDesc, marginBottom: 32 }}>{t.installDesc}</p>

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
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 16px", color: colors.text }}>{t.stepsTitle}</h3>
              <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {client.steps[lang].map((step, i) => (
                  <li key={i} style={{ display: "flex", gap: 12, marginBottom: 14 }}>
                    <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: "50%", background: colors.primary, color: "#fff", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                      {i + 1}
                    </span>
                    <span style={{ fontSize: 15, color: colors.textDim, lineHeight: 1.5 }}>{step}</span>
                  </li>
                ))}
              </ol>
              <a href={client.docsUrl} target="_blank" rel="noopener noreferrer" style={docsLink}>
                {client.docsLabel[lang]} →
              </a>
              <div style={{ marginTop: 16, padding: 14, borderRadius: 8, background: colors.bgAlt, border: `1px solid ${colors.border}` }}>
                <p style={{ fontSize: 13, color: colors.textDim, margin: 0 }}>
                  <strong style={{ color: colors.text }}>{t.fileLocation}</strong><br />
                  <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: colors.textDim, wordBreak: "break-all" }}>
                    {client.filename_mac}
                  </code>
                </p>
              </div>
            </div>

            {/* Config */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: colors.text }}>{t.configTitle}</h3>
                <CopyButton text={client.config} lang={lang} />
              </div>
              <pre style={{ ...codeBlock, margin: 0 }}>
                <code>{client.config}</code>
              </pre>
            </div>
          </div>

          {/* DBW key note */}
          <div style={{ marginTop: 32, padding: 18, borderRadius: 10, background: "rgba(46,160,67,0.08)", border: "1px solid rgba(46,160,67,0.25)" }}>
            <p style={{ fontSize: 14, color: colors.textDim, margin: 0 }}>
              <strong style={{ color: colors.accentHover }}>{t.dbwKeyTitle}</strong> {t.dbwKeyDesc} <code style={inlineCode}>X-DBW-Key</code> {t.dbwKeyDesc2} <a href="https://api.stat.gov.pl" target="_blank" rel="noopener" style={{ color: colors.accentHover }}>api.stat.gov.pl</a>. {t.dbwKeyDesc3}
            </p>
          </div>
        </div>
      </section>

      {/* Examples */}
      <section id="examples" style={{ padding: "64px 24px", borderTop: `1px solid ${colors.border}`, background: colors.bgAlt }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <h2 style={sectionTitle}>{t.examplesTitle}</h2>
          <p style={{ ...sectionDesc, marginBottom: 36 }}>{t.examplesDesc}</p>
          <div style={{ display: "grid", gap: 16 }}>
            {examples.map((ex, i) => (
              <div key={i} style={exampleCard} className="ex-card">
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
          <h2 style={sectionTitle}>{t.toolsTitle}</h2>
          <p style={{ ...sectionDesc, marginBottom: 36 }}>{t.toolsDesc}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
            {TOOLS.map((tool) => (
              <div key={tool.name} style={{ padding: 20, borderRadius: 10, background: colors.card, border: `1px solid ${colors.border}` }}>
                <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: colors.primary, fontWeight: 500 }}>{tool.name}</code>
                <p style={{ fontSize: 14, color: colors.textDim, margin: "8px 0 0", lineHeight: 1.45 }}>{tool.desc[lang]}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Coffee */}
      <section id="coffee" style={{ padding: "80px 24px", borderTop: `1px solid ${colors.border}`, background: colors.bgAlt, textAlign: "center" }}>
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <h2 style={{ ...sectionTitle, marginBottom: 12 }}>{t.coffeeTitle}</h2>
          <p style={{ ...sectionDesc, marginBottom: 32 }}>{t.coffeeDesc}</p>
          <a href="https://buymeacoffee.com/arek_g" target="_blank" rel="noopener" style={{ ...coffeeBtn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 20 }}>☕</span> {t.coffeeBtn}
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ padding: "32px 24px", borderTop: `1px solid ${colors.border}`, textAlign: "center" }}>
        <p style={{ fontSize: 13, color: colors.textDim, margin: 0 }}>
          {lang === "pl" ? "Serwer" : "Server"}: <code style={inlineCode}>{SERVER_URL.replace("https://", "")}</code>
        </p>
        <p style={{ fontSize: 13, color: colors.textDim, margin: "8px 0 0" }}>
          {t.footerData}
        </p>
      </footer>
    </div>
  );
}

// Hover effects via injected style tag
const styleSheet = `
  a:hover { color: ${colors.text} !important; }
  .ex-card:hover { border-color: ${colors.primary} !important; transform: translateY(-2px); }
  button:hover { opacity: 0.85; }
  .ex-card, button, a { transition: all .15s ease; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  ::selection { background: ${colors.primary}; color: #fff; }
  @media (max-width: 720px) {
    #install > div > div[style*="grid"] { grid-template-columns: 1fr !important; }
  }
`;
const styleTag = document.createElement("style");
styleTag.textContent = styleSheet;
document.head.appendChild(styleTag);
