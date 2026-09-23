# Voice Agent Demo

Talk to a Snowflake Cortex Agent with your voice or by typing. Built with SvelteKit, ElevenLabs Scribe (speech-to-text), and Snowflake App Runtime.

## Architecture

Voice in via ElevenLabs Scribe, query via a Snowflake Cortex Agent over
pre-aggregated retail data, voice out via self-hosted Kokoro TTS on Snowpark
Container Services — with graceful fallback to browser speech.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full design: component map,
data flow, latency work, voice-activity detection, SPCS lifecycle gotchas, and
cost.

## Prerequisites

- A Snowflake account with a deployed Cortex Agent (e.g. `RETAIL_ANALYTICS_AGENT`)
- A Snowflake Personal Access Token (PAT)
- An ElevenLabs account (free tier works) and API key

## Setup

1. Clone this repo:

```bash
git clone https://github.com/sfc-gh-rmoceri/voice-agent-demo.git
cd voice-agent-demo
```

2. Install dependencies:

```bash
npm install
```

3. Create `config.json` from the example:

```bash
cp config.example.json config.json
```

4. Edit `config.json` with your credentials:

```json
{
  "snowflake": {
    "account": "your-account-identifier",
    "token": "your-personal-access-token",
    "database": "INTERACTIVE_DEMO",
    "schema": "RETAIL",
    "agent": "RETAIL_ANALYTICS_AGENT"
  },
  "elevenlabs": {
    "api_key": "your-elevenlabs-api-key"
  }
}
```

### Getting an ElevenLabs API Key

1. Sign up at [elevenlabs.io](https://elevenlabs.io) (free tier includes ~30 min of STT/month)
2. Go to Profile > API Keys
3. Copy the key into `config.json`

### Getting a Snowflake PAT

Generate a PAT in Snowsight under your user menu, or via CLI.

### Snowflake CLI connection

The `tts:*` scripts shell out to `snow`, and use your **default** connection. To
point them at a specific one:

```bash
export SNOWFLAKE_DEFAULT_CONNECTION_NAME=my_connection
```

## Run Locally

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Click the orb to record, or
type a question.

The app is fully usable at this point — it falls back to the browser's built-in
speech synthesis for the spoken replies. The self-hosted TTS in the next section
is optional and sounds considerably better.

## Deploy to Snowflake App Runtime

```bash
snow app setup
snow app deploy
```

Set environment variables for deployed mode (instead of config.json):

- `SNOWFLAKE_ACCOUNT`
- `SNOWFLAKE_TOKEN`
- `SNOWFLAKE_DATABASE`
- `SNOWFLAKE_SCHEMA`
- `SNOWFLAKE_AGENT`
- `ELEVENLABS_API_KEY`

## Voice Output: Kokoro TTS on Snowpark Container Services

Speech output is served by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
running as a container inside your own Snowflake account, via
[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI). No third-party TTS
account, no per-character billing, and the text never leaves Snowflake.

The browser's built-in `speechSynthesis` is the fallback, so the app always
speaks even when the service is off.

### One-time setup

```bash
npm run tts:setup    # database, schema, image repo, role, compute pool (ACCOUNTADMIN)
npm run tts:image    # pull ~5GB image, push to your Snowflake registry
npm run tts:create   # create the service
```

### Day-to-day

```bash
npm run tts:up       # resume the pool before a demo
npm run tts:status   # check pool and service state
npm run tts:down     # suspend when finished
```

You can also use the **Warm up / Shut down** button in the app's voice panel,
which polls until the service is ready and flips the engine badge from
`Browser voice` to `Kokoro on SPCS`.

### Cold start is slow — warm up first

Going from suspended to serving takes **several minutes**: node provisioning,
then a ~5 GB image pull, then model load. This is why the app never blocks on
a cold service — it checks state first and falls back to browser speech if
Kokoro is not ready.

Warm it up a few minutes before you demo.

### Cost

| State | Cost |
|-------|------|
| Running (`CPU_X64_M`, 6 vCPU) | ~1.1 credits/hr |
| Suspended | Zero |

The pool auto-suspends after 15 minutes of inactivity (`AUTO_SUSPEND_SECS = 900`),
and `npm run tts:down` stops it immediately. Compute pools bill only in ACTIVE,
IDLE, STOPPING and RESIZING states — never SUSPENDED.

> **Important:** `AUTO_SUSPEND_SECS` measures *no services and no jobs running*
> on the pool. A running service counts as activity, so the pool will **not**
> auto-suspend while `KOKORO_TTS` is up. Always run `npm run tts:down` (or use
> the Shut down button) when you finish — otherwise it bills indefinitely.

To trade cost for latency, switch the pool to a GPU instance family:

```sql
ALTER COMPUTE POOL VOICE_TTS_POOL SUSPEND;
ALTER COMPUTE POOL VOICE_TTS_POOL SET INSTANCE_FAMILY = GPU_NV_S;
ALTER COMPUTE POOL VOICE_TTS_POOL RESUME;
```

That drops generation to sub-second at roughly 3x the credit rate, and needs
the GPU image (`ghcr.io/remsky/kokoro-fastapi-gpu`) pushed instead.

### Changing the voice

Kokoro ships several voices and supports blending. Edit the `voice` field in
[src/routes/api/text-to-speech/+server.ts](src/routes/api/text-to-speech/+server.ts):

```ts
voice: 'af_heart'          // single voice
voice: 'af_sky+af_bella'   // weighted blend
```

## How It Works

### Voice Input

1. User clicks the orb
2. `MediaRecorder` captures audio as `audio/webm`, with a live circular waveform
   driven by the Web Audio API analyser
3. On stop, the audio blob is sent to `/api/speech-to-text`
4. Server calls ElevenLabs `speechToText.convert()` with the `scribe_v2` model
5. Transcribed text is injected into the chat and auto-sent

### Voice Output

1. `/api/tts-status` reports whether the Kokoro service is READY
2. If ready, `/api/text-to-speech` streams MP3 from the SPCS ingress endpoint,
   authenticating with a PAT (`Authorization: Snowflake Token="..."`)
3. Audio is piped through as a `ReadableStream` so playback starts before
   generation finishes
4. On any failure the route returns `503 { fallback: true }` and the client
   uses browser speech synthesis instead

### Chat

1. User message + conversation history is sent to `/api/chat`
2. Server proxies to the Cortex Agent `:run` endpoint with `Accept: text/event-stream`
3. SSE events are forwarded raw to the browser
4. Client parses: `response.text.delta` (streaming text), `response.chart` (Vega-Lite), `response.table` (result sets), `response.status` (progress indicators)
5. Markdown is rendered with `marked`, Mermaid diagrams with `mermaid`, charts with `vega-embed`

### SSE Deduplication

The Cortex Agent duplicates content items in the final `response` event. The client:
- Deduplicates charts and tables by `tool_use_id`
- Uses the last non-empty text block (not the first)

## Tech Stack

- [SvelteKit](https://svelte.dev/docs/kit) with `adapter-node` for standalone Node.js server
- [ElevenLabs Scribe v2](https://elevenlabs.io/speech-to-text-api) for speech-to-text ($0.22/hr, free tier available)
- [Snowflake Cortex Agent](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agent) for natural language data queries
- [Vega-Lite](https://vega.github.io/vega-lite/) / [vega-embed](https://github.com/vega/vega-embed) for chart rendering
- [Marked](https://marked.js.org/) + [Mermaid](https://mermaid.js.org/) for markdown/diagram rendering

## License

MIT
