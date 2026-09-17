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
- **Memory:** SQLite (via Node's built-in `node:sqlite`) + `sqlite-vec` for
  vector search, `transformers.js` for local embeddings

## Getting started

1. `npm install` in both `client/` and `server/`
2. Point the server at your LLM provider — either edit `server/config.js`
   directly, or run the app once and set it from the Settings panel's AI
   Provider section. Defaults assume LM Studio at
   `http://localhost:1234/v1/chat/completions`.
3. Start both the client and server dev processes (check each folder's
   `package.json` for the exact script names/ports in your setup).
4. Open the app, pick a VRM character under Settings, and start chatting.

> Node 22.13+ is required for the memory system (it uses Node's built-in
> `node:sqlite`). If you're on an older Node, upgrade first — `node -v` to
> check.

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

Every time you send a message, three things happen, none of which block
your reply:

1. **Known facts get pulled in.** The app keeps a running list of things
   it's learned about you and your projects in a small local database.
   These are added to every conversation automatically.
2. **Sometimes, it searches past conversations.** If your message sounds
   like it's referencing something from before ("remember when...", "what
   did we decide about...") the app searches summaries of past
   conversations for anything relevant and works it into context. If your
   message doesn't sound like that, this step is skipped entirely — it
   isn't running a search on every single message.
3. **After the reply, memory updates in the background.** A quick,
   separate step reads the exchange and pulls out anything worth
   remembering long-term. Every so often — and whenever you switch to a
   different conversation — older material gets compressed into a summary,
   which is what step 2 searches through later.

Everything above lives in `server/lib/memory/` — six small files, one per
responsibility (facts, summaries, retrieval, embeddings, the database, and
a small orchestration layer that ties them together). See `ai.md` for the
file-by-file breakdown.

### The concepts, explained

**SQLite** — a full relational database that lives in a single file on
disk, with no separate database server to install or run. It's a natural
fit for a local-first app: the whole memory store is just one `.db` file
you could back up by copying it.
Read more: https://www.sqlite.org/about.html

**`node:sqlite`** — Node.js has shipped its own built-in SQLite module
since version 22.13. This app uses it instead of the more common
`better-sqlite3` package specifically because `better-sqlite3` has to be
compiled from C++ source on install, which can break on a Windows machine
without a properly configured build toolchain (which is exactly what
happened during development). Node's built-in version needs no compilation
at all.
Read more: https://nodejs.org/api/sqlite.html

**Embeddings (vectors)** — an embedding is a list of numbers — 384 of them,
here — that represents the *meaning* of a piece of text, produced by a
small AI model. Text with similar meaning ends up with similar numbers, so
"I love hiking" and "trails are my favorite" land close together in that
number-space even though they don't share a single word. That's what makes
searching *by meaning* possible, instead of only by exact keyword match.
Read more: https://www.ibm.com/think/topics/vector-embedding

**`sqlite-vec`** — a SQLite extension that adds the ability to store these
number-lists and efficiently answer "which of these thousands of vectors
is closest to this one?" It runs entirely locally as a small C extension —
no cloud service, no separate vector database to run.
Read more: https://github.com/asg017/sqlite-vec

**RAG (Retrieval-Augmented Generation)** — the general pattern this memory
system is one small example of. Rather than a language model relying
purely on what it "remembers" from training or from the current
conversation, RAG *retrieves* relevant information from an outside store
right before generating a reply, and feeds it in as extra context. It's
the standard way to give an LLM access to information beyond its training
data or its context window, without retraining it.
Read more: https://www.ibm.com/think/topics/retrieval-augmented-generation
