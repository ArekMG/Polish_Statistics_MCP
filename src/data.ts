const SERVER_URL = "https://lhvabobevgbaunznyxcw.supabase.co/functions/v1/dbw-mcp";

type Lang = "pl" | "en";

type ExampleQuestion = { question: string; tag: string };
type Tool = { name: string; desc: Record<Lang, string> };
type Client = {
  id: string;
  name: string;
  docsUrl: string;
  docsLabel: Record<Lang, string>;
  config: string;
  configLang: "json" | "toml";
  filename_mac: string;
  filename_win: string;
  steps: Record<Lang, string[]>;
};

const EXAMPLE_QUESTIONS: Record<Lang, ExampleQuestion[]> = {
  pl: [
    { question: "Czy bogatsze województwa „kupują” sobie dodatkowe lata życia w zdrowiu?", tag: "Zdrowie · Nierówności" },
    { question: "Czy dostępność mieszkań poprawiła się w latach 2015–2023 — i w których województwach pogorszyła się najbardziej?", tag: "Mieszkania · Regiony" },
    { question: "Które powiaty wyludniają się najszybciej i w jakim stopniu to efekt niskiej dzietności, a w jakim migracji?", tag: "Demografia · Analiza" },
  ],
  en: [
    { question: "Do richer voivodeships „buy” extra years of healthy life?", tag: "Health · Inequality" },
    { question: "Did housing availability improve in 2015–2023 — and in which voivodeships did it worsen the most?", tag: "Housing · Regions" },
    { question: "Which counties are depopulating fastest, and how much is low fertility vs. migration?", tag: "Demographics · Analysis" },
  ],
};

const TOOLS: Tool[] = [
  { name: "search_areas", desc: { pl: "Przeglądaj dziedziny statystyczne GUS — od ludności po przemysł.", en: "Browse GUS statistical domains — from population to industry." } },
  { name: "find_variables", desc: { pl: "Znajdź zmienne statystyczne po nazwie lub słowach kluczowych.", en: "Find statistical variables by name or keywords." } },
  { name: "get_data_series", desc: { pl: "Pobierz dane dla wielu lat i przekrojów w jednym wywołaniu.", en: "Fetch data for multiple years and cross-sections in one call." } },
  { name: "aggregate", desc: { pl: "Agreguj dane: średnia, suma, min, max — liczone po stronie serwera.", en: "Aggregate data: mean, sum, min, max — computed server-side." } },
  { name: "quota_status", desc: { pl: "Sprawdź ile zapytań do DBW zostało w limicie.", en: "Check how many DBW requests remain in your budget." } },
  { name: "get_section_dimensions", desc: { pl: "Filtruj pozycje po poziomie terytorialnym: powiat, województwo, Polska.", en: "Filter positions by territorial level: county, voivodeship, country." } },
];

const CLAUDE_CONFIG = `{
  "mcpServers": {
    "polish-stats": {
      "url": "${SERVER_URL}"
    }
  }
}`;

const CODEX_CONFIG = `# ~/.codex/config.toml
[mcp_servers.polish-stats]
command = "npx"
args = ["mcp-remote@latest", "${SERVER_URL}"]`;

const OPENCODE_CONFIG = `{
  "mcp": {
    "polish-stats": {
      "type": "local",
      "command": ["npx", "mcp-remote@latest", "${SERVER_URL}"]
    }
  }
}`;

const CLIENTS: Client[] = [
  {
    id: "claude",
    name: "Claude Desktop",
    docsUrl: "https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop",
    docsLabel: { pl: "Oficjalna dokumentacja Claude", en: "Official Claude documentation" },
    config: CLAUDE_CONFIG,
    configLang: "json",
    filename_mac: "~/Library/Application Support/Claude/claude_desktop_config.json",
    filename_win: "%APPDATA%\\Claude\\claude_desktop_config.json",
    steps: {
      pl: [
        "Otwórz Claude Desktop → Settings → Developer → Edit Config.",
        "Wklej konfigurację po prawej stronie, zapisz plik.",
        "Uruchom ponownie Claude Desktop.",
        "Zadaj pytanie — np. jedno z przykładów poniżej.",
      ],
      en: [
        "Open Claude Desktop → Settings → Developer → Edit Config.",
        "Paste the configuration on the right, save the file.",
        "Restart Claude Desktop.",
        "Ask a question — try one of the examples below.",
      ],
    },
  },
  {
    id: "codex",
    name: "Codex CLI",
    docsUrl: "https://github.com/openai/codex",
    docsLabel: { pl: "Oficjalna dokumentacja Codex CLI", en: "Official Codex CLI documentation" },
    config: CODEX_CONFIG,
    configLang: "toml",
    filename_mac: "~/.codex/config.toml",
    filename_win: "%USERPROFILE%\\.codex\\config.toml",
    steps: {
      pl: [
        "Zainstaluj Codex CLI: npm install -g @openai/codex",
        "Utwórz plik ~/.codex/config.toml (lokalizacja po prawej).",
        "Wklej konfigurację TOML i zapisz.",
        "Uruchom codex w terminalu i zadaj pytanie.",
      ],
      en: [
        "Install Codex CLI: npm install -g @openai/codex",
        "Create the file ~/.codex/config.toml (path on the right).",
        "Paste the TOML configuration and save.",
        "Run codex in your terminal and ask a question.",
      ],
    },
  },
  {
    id: "opencode",
    name: "OpenCode (darmowe modele / free models)",
    docsUrl: "https://opencode.ai/docs/config#mcp",
    docsLabel: { pl: "Oficjalna dokumentacja OpenCode", en: "Official OpenCode documentation" },
    config: OPENCODE_CONFIG,
    configLang: "json",
    filename_mac: "~/.config/opencode/opencode.json",
    filename_win: "%APPDATA%\\opencode\\opencode.json",
    steps: {
      pl: [
        "Zainstaluj OpenCode: npm install -g opencode-ai",
        "Utwórz plik konfiguracyjny w lokalizacji po prawej.",
        "Wklej konfigurację JSON i zapisz.",
        "Uruchom opencode — możesz używać darmowych modeli LLM.",
      ],
      en: [
        "Install OpenCode: npm install -g opencode-ai",
        "Create the config file at the path on the right.",
        "Paste the JSON configuration and save.",
        "Run opencode — you can use free LLM models.",
      ],
    },
  },
];

const UI = {
  pl: {
    badge: "Model Context Protocol · Dane GUS / DBW",
    heroTitle1: "Pytaj o polskie statystyki",
    heroTitle2: "w naturalnym języku",
    heroDesc: "Serwer MCP łączący Twoje AI z bazą danych GUS / DBW. Zadawaj pytania — otrzymuj odpowiedzi oparte na rzeczywistych danych.",
    installBtn: "Zainstaluj",
    examplesBtn: "Zobacz przykłady",
    installTitle: "Instalacja",
    installDesc: "Wybierz klienta AI, wklej konfigurację i rozpocznij rozmowę. Trwa to mniej niż minutę.",
    stepsTitle: "Krok po kroku",
    configTitle: "Konfiguracja",
    fileLocation: "Plik konfiguracyjny:",
    dbwKeyTitle: "Klucz API DBW (opcjonalny):",
    dbwKeyDesc: "Serwer działa bez klucza — korzystasz z współdzielonego limitu zapytań. Dla własnego, większego limitu dodaj nagłówek",
    dbwKeyDesc2: "z Twoim kluczem API z",
    dbwKeyDesc3: "Pobrane dane są buforowane przez 6 godzin.",
    examplesTitle: "Przykładowe pytania",
    examplesDesc: "Oto pytania, które serwer potrafi obsłużyć — od analizy demograficznej po dostępność mieszkań.",
    toolsTitle: "Dostępne narzędzia",
    toolsDesc: "AI korzysta z tych narzędzi automatycznie, gdy odpowiada na Twoje pytania.",
    coffeeTitle: "Podoba Ci się?",
    coffeeDesc: "Ten projekt jest darmowy i open-source. Jeśli ułatwił Ci pracę — postaw kawę!",
    coffeeBtn: "Postaw kawę",
    footerData: "Dane: GUS / Bank Danych Wojskowych · Projekt open-source",
    langToggle: "EN",
  },
  en: {
    badge: "Model Context Protocol · GUS / DBW Data",
    heroTitle1: "Ask about Polish statistics",
    heroTitle2: "in natural language",
    heroDesc: "An MCP server connecting your AI to Poland's official statistical database (GUS / DBW). Ask questions — get answers grounded in real data.",
    installBtn: "Install",
    examplesBtn: "See examples",
    installTitle: "Installation",
    installDesc: "Pick an AI client, paste the configuration, and start chatting. It takes less than a minute.",
    stepsTitle: "Step by step",
    configTitle: "Configuration",
    fileLocation: "Config file:",
    dbwKeyTitle: "DBW API key (optional):",
    dbwKeyDesc: "The server works without a key — you share a communal request budget. For your own larger budget, add the header",
    dbwKeyDesc2: "with your API key from",
    dbwKeyDesc3: "Downloaded data is cached for 6 hours.",
    examplesTitle: "Example questions",
    examplesDesc: "Here are questions the server can handle — from demographic analysis to housing availability.",
    toolsTitle: "Available tools",
    toolsDesc: "Your AI uses these tools automatically when answering your questions.",
    coffeeTitle: "Like this project?",
    coffeeDesc: "This project is free and open-source. If it made your work easier — buy me a coffee!",
    coffeeBtn: "Buy me a coffee",
    footerData: "Data: GUS / Bank of Local Data · Open-source project",
    langToggle: "PL",
  },
};

export const PAGE_DATA = { SERVER_URL, EXAMPLE_QUESTIONS, TOOLS, CLIENTS, UI };
export type { Lang };
