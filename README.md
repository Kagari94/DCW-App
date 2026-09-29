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
npm start
```

In a second terminal run `npm run dev:client` and open the URL Vite prints.
Enter the access token printed by the backend. Configure the model provider in
Settings; the default endpoint is `http://localhost:1234/v1/chat/completions`.
Upload a VRM character in Settings; personal models and saved data are ignored by Git.

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
Deleting a chat removes its searchable summary but keeps its user facts.
You can add, edit, and pin facts there. An edited fact is protected from later
automatic extraction; forgetting one also prevents old chats from restoring it.
Reordered topic names such as `japanese_learning` and `learning_japanese`
reuse one fact. On startup, duplicate copies with identical text are consolidated;
their original records, pins, and history are preserved.

Recent and pinned facts are included within a fixed prompt budget. When a
message refers to an earlier chat, SQLite FTS5 searches past summaries.
A queued background worker combines summary updates and fact extraction in
one model call per bounded chunk after a chat goes idle or you switch chats. Pending work is
recovered on restart. Normal recall does not download or load an embedding
model. Existing vector records are retained for migration safety.

The database is `server/data/memory.db`. A versioned backup is created
before the first schema migration. The implementation lives in
`server/lib/memory/`; the public entrypoint is `index.js`.
Run `npm run memory:check` for a read-only integrity and job-status report.
