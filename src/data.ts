const SERVER_URL = "https://lhvabobevgbaunznyxcw.supabase.co/functions/v1/dbw-mcp";

const EXAMPLE_QUESTIONS = [
  {
    question: "Czy bogatsze województwa „kupują” sobie dodatkowe lata życia w zdrowiu?",
    tag: "Zdrowie · Nierówności",
  },
  {
    question: "Czy dostępność mieszkań poprawiła się w latach 2015–2023 — i w których województwach pogorszyła się najbardziej?",
    tag: "Mieszkania · Regiony",
  },
  {
    question: "Które powiaty wyludniają się najszybciej i w jakim stopniu to efekt niskiej dzietności, a w jakim migracji?",
    tag: "Demografia · Analiza",
  },
];

const TOOLS = [
  { name: "search_areas", desc: "Przeglądaj dziedziny statystyczne GUS — od ludności po przemysł." },
  { name: "find_variables", desc: "Znajdź zmienne statystyczne po nazwie lub słowach kluczowych." },
  { name: "get_data_series", desc: "Pobierz dane dla wielu lat i przekrojów w jednym wywołaniu." },
  { name: "aggregate", desc: "Agreguj dane: średnia, suma, min, max — liczone po stronie serwera." },
  { name: "quota_status", desc: "Sprawdź ile zapytań do DBW zostało w limicie." },
  { name: "get_section_dimensions", desc: "Filtruj pozycje po poziomie terytorialnym: powiat, województwo, Polska." },
];

const CLAUDE_CONFIG = `{
  "mcpServers": {
    "polish-stats": {
      "url": "${SERVER_URL}"
    }
  }
}`;

const CODEX_CONFIG = `{
  "mcpServers": {
    "polish-stats": {
      "url": "${SERVER_URL}"
    }
  }
}`;

const OPENCODE_CONFIG = `[mcp.polish-stats]
url = "${SERVER_URL}"`;

type Client = {
  id: string;
  name: string;
  config: string;
  filename: string;
  filename_mac: string;
  filename_win: string;
  steps: string[];
};

const CLIENTS: Client[] = [
  {
    id: "claude",
    name: "Claude Desktop",
    config: CLAUDE_CONFIG,
    filename: "claude_desktop_config.json",
    filename_mac: "~/Library/Application Support/Claude/claude_desktop_config.json",
    filename_win: "%APPDATA%\\Claude\\claude_desktop_config.json",
    steps: [
      "Otwórz Claude Desktop → Settings → Developer → Edit Config.",
      "Wklej konfigurację po prawej stronie, zapisz plik.",
      "Uruchom ponownie Claude Desktop.",
      "Zadaj pytanie — np. jedno z przykładów poniżej.",
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    config: CODEX_CONFIG,
    filename: "config.json",
    filename_mac: "~/.codex/config.json",
    filename_win: "%USERPROFILE%\\.codex\\config.json",
    steps: [
      "Utwórz plik konfiguracyjny w lokalizacji po prawej (lub użyj codex --config).",
      "Wklej konfigurację JSON i zapisz.",
      "Uruchom codex w terminalu.",
      "Zadaj pytanie w trybie konwersacji.",
    ],
  },
  {
    id: "opencode",
    name: "OpenCode (darmowe modele)",
    config: OPENCODE_CONFIG,
    filename: "opencode.json",
    filename_mac: "~/.config/opencode/opencode.json",
    filename_win: "%APPDATA%\\opencode\\opencode.json",
    steps: [
      "Zainstaluj OpenCode: npm install -g opencode-ai.",
      "Utwórz plik konfiguracyjny w lokalizacji po prawej.",
      "Wklej konfigurację TOML i zapisz.",
      "Uruchom opencode — możesz używać darmowych modeli LLM.",
    ],
  },
];

export const PAGE_DATA = { SERVER_URL, EXAMPLE_QUESTIONS, TOOLS, CLIENTS };
