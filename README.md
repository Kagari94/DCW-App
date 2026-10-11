# Desktop Companion App

A local-first AI desktop companion: a VRM anime-style 3D character with LLM
chat, voice I/O, tool-calling, and real-time expression/animation control.
Runs entirely on your own machine by default — LM Studio for local
inference, or bring your own OpenAI-compatible cloud endpoint if you'd
rather.

---

## Features

- **A live 3D character** — VRM avatar with expression and animation synced
  to what it's saying
- **Multiple companions** — each can save its own name, personality, voice,
  chat history, and optional animations while sharing the user's memory
- **Saved outfits** — choose named VRMs and card images in the chat bar's
  Companion window, or ask the companion to change clothes
- **Stock watchlist** — the chat bar's Stocks window follows selected US/European
  stocks through Yahoo Finance, with configurable checks, saved holdings, price/news
  alerts, companion explanations and optional voice. See [Stock monitoring](STOCKS.md).
- **Voice in, voice out** — speech-to-text via Whisper, text-to-speech via
  Kokoro / Pocket TTS, streamed sentence-by-sentence so playback starts
  before the whole reply has finished
- **Provider-agnostic LLM** — LM Studio locally, or OpenAI / any
  OpenAI-compatible cloud endpoint, switchable from Settings
- **Tool-calling** — the model can search the web, fetch pages, browse a
  sandboxed folder on disk, view images it finds there, generate PDFs and
  Word docs, and more
- **Screen sharing** — the character can see your screen on request, via a
  one-click session (starts once, stays authorized for follow-up frame
  grabs without asking again)
- **Persistent memory** *(new)* — the app remembers facts about you and your
  projects across conversations, and can pull in relevant context from past
  chats when it seems relevant. See [How memory works](#how-the-memory-system-works)
  below.
- Markdown-rendered replies, a live-theming CSS layer, and a growing
  Settings panel for provider, voice, and character configuration

## Tech stack

- **Frontend:** React + Vite
- **Backend:** Node.js + Express
- **LLM inference:** LM Studio (local) or any OpenAI-compatible API
- **3D:** Three.js + `@pixiv/three-vrm`
- **Voice:** Whisper (speech-to-text), Kokoro / Pocket TTS (text-to-speech)
- **Memory:** SQLite (via Node's built-in `node:sqlite`) with FTS5 text search

## Getting started

Use Node 22.13+ (the memory database uses `node:sqlite`). From the repository root:

```sh
npm install
npm install --prefix client
npm run dev:server
```

In a second terminal run `npm run dev:client` and open the URL Vite prints.
`dev:server` restarts the backend when server code changes; use `npm start`
when you want a normal run without file watching.
Enter the access token printed by the backend. Configure the model provider in
Settings; the default endpoint is `http://localhost:1234/v1/chat/completions`.
Open Companion (👕) from the chat bar; its Model tab's **+** card creates a
companion from an uploaded or existing VRM. Personal models and saved data are ignored by Git.
See [Companions](CHARACTERS.md) for the folder layout and character settings.

The backend listens on port 3000. The client probes HTTPS port 3443 first,
then permits HTTP port 3000 only when the page itself uses HTTP. For remote
microphone/camera access, serve the frontend over HTTPS and configure a trusted
HTTPS reverse proxy (such as Caddy) on backend port 3443. No proxy is bundled.
Failed application requests are never automatically replayed.

Optional: copy `server/assets/system-prompt.example.md` to
`server/assets/system-prompt.md` for a personal prompt. The example is used when
no custom prompt exists. Existing custom prompts and saved data are preserved.

Checks: `npm run check`, `npm test`, `npm run lint`, `npm run build`.
Tests use temporary conversation stores and mocked AI responses, not personal data.

## Known limitations

- **Anthropic/Claude isn't a supported provider** — its API shape is
  different enough from the OpenAI-style chat completions format that it's
  not a drop-in; would need dedicated work.
- **DuckDuckGo web search is a last-resort fallback only** — it actively
  resets connections for automated traffic. SearXNG (self-hosted) is the
  recommended default; Brave is a paid-key alternative.
- **Screen sharing needs a manual click to start** — a hard browser
  security rule, not a bug. Once started, follow-up frame grabs don't need
  another click, but the very first one always will.
- **File access is sandboxed to one folder you configure**, and deletions
  are soft (moved to a `.trash/` folder, never actually removed) — there is
  no way for the model to permanently delete a file.

---

## How the memory system works

User facts, including wants, needs, and preferences, stay in the local SQLite
database until you select **Forget** for a fact in Settings → User memory.
Deleting a chat removes its searchable episodes but keeps its user facts.
You can add, edit, and pin facts, inspect their evidence/history, and review
suggested changes there. Automatic extraction cannot replace a saved fact;
new values require your **Accept** or **Save**. Supporting quotes must come
from user messages; quoted examples and hypothetical statements are excluded.
**Forget** removes the selected fact and its history, blocks automatic restoration,
and resets derived past-conversation recall. Saved transcripts/backups and other
user facts remain; fresh conversation material builds new recall snapshots.
Reordered topic names such as `japanese_learning` and `learning_japanese`
reuse one fact. On startup, duplicate copies with identical text are consolidated;
their original records, pins, and history are preserved.

Pinned/core and relevant facts fit within separate budgets (2,000 estimated
tokens total by default). SQLite FTS5 searches relevant passages for substantive
messages, including those without "remember" cues. User facts are shared across
companions; episodes belong to their character. Unresolved old chats stay in a
legacy scope. Older passages survive rolling-summary updates.
A queued background worker combines summary updates and fact extraction in
one model call per bounded chunk after 45 seconds idle or a chat switch. Ordinary
turns restart that delay, with a five-minute maximum postponement. New background
inference yields to chat and voice; already-running requests can still overlap.
Pending work and retry delays survive restart. Normal recall loads no embedding
model. Existing vector records are retained for migration safety.
Changing the selected model or connection settings resumes unsuccessful jobs
after the idle delay. After repairing a server without changing settings, run
`npm run memory:retry` to resume them; facts, cursors, and active requests stay intact.
Background extraction has a 120-second deadline for slower/thinking models.
`COMPANION_MEMORY_TIMEOUT_MS` adjusts it (1–300 seconds); an expired request is
canceled and queued with backoff. The worker still starts only one request at a time.

The database is `server/data/memory.db`. A versioned backup is created
before each schema upgrade; version 5 preserves existing fact IDs and revisions.
The implementation lives in
`server/lib/memory/`; the public entrypoint is `index.js`.
Run `npm run memory:check` for a read-only integrity and job-status report.

`npm run memory:benchmark -- --size=10000` evaluates synthetic English/Finnish
queries, negative matches, scope, context size, and coalesced background work in a
temporary database. `--live` additionally measures first-token latency against
the configured model using synthetic prompts; it makes three inference requests.
It also checks streamed reply validity and English/Finnish extraction through the
real memory pipeline. Special-token output or invalid JSON is reported as a
failed extraction; first-token timing alone does not prove usable inference.
The live check allows 512 output tokens so a thinking model can reach its reply.
Use `--live-timeout-ms=180000` or `--live-max-tokens=1024` for a slower model.
Missing replies or failed English/Finnish evidence checks produce a failing exit code.

Standalone greetings and acknowledgements omit tool schemas, use up to 600 bytes
of saved facts, and skip episode retrieval. Requests, attachments, and tool
continuations retain their tools. DEBUG logs show message/tool/request byte counts
for chat and background memory without printing memory values. Run
`node scripts/check-chat-context.js --running-tools` to inspect context overhead.

Optional semantic recall defaults off. Set `COMPANION_MEMORY_SEMANTIC=1` before
starting the server to enable idle embedding work and fallback on weak lexical
matches. Cold loading happens in the background; warm queries have a 150 ms
deadline and bounded caches. `COMPANION_MEMORY_EMBEDDING_MODEL` selects the model
(default: the retained `Xenova/all-MiniLM-L6-v2`). It can download model weights
on first use. Compare candidates with `memory:benchmark -- --semantic` before
enabling one, especially for Finnish. No model has been downloaded or enabled
by this upgrade. `COMPANION_MEMORY_CONTEXT_TOKENS` adjusts the estimated prompt
budget; token estimates are conservative byte-based estimates, not a tokenizer.
