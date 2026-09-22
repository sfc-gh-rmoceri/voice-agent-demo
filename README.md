# Voice Agent Demo

Talk to a Snowflake Cortex Agent with your voice or by typing. Built with SvelteKit, ElevenLabs Scribe (speech-to-text), and Snowflake App Runtime.

## Architecture

```
Browser                              SvelteKit Server                    External
  |                                    |                                   |
  |-- MediaRecorder (audio/webm) ---> /api/speech-to-text -------------> ElevenLabs Scribe v2
  |<-- { text } ----------------------|                                   |
  |                                    |                                   |
  |-- { message, history } ----------> /api/chat (SSE proxy) ----------> Cortex Agent :run
  |<-- SSE stream --------------------|                                   |
```

- Voice input is recorded in the browser, sent to ElevenLabs for transcription, then the text is sent to the Cortex Agent
- The Cortex Agent SSE stream is proxied through the server to keep the PAT secret
- Charts (Vega-Lite) and tables from Cortex Analyst are rendered inline

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

## Run Locally

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Click the microphone button to record, or type a question.

## Deploy to Snowflake App Runtime

```bash
snow app setup
snow app deploy -c sfsenorthamerica-rmoceri_awse1
```

Set environment variables for deployed mode (instead of config.json):

- `SNOWFLAKE_ACCOUNT`
- `SNOWFLAKE_TOKEN`
- `SNOWFLAKE_DATABASE`
- `SNOWFLAKE_SCHEMA`
- `SNOWFLAKE_AGENT`
- `ELEVENLABS_API_KEY`

## How It Works

### Voice Input

1. User clicks the microphone button
2. `MediaRecorder` captures audio as `audio/webm`
3. On stop, the audio blob is sent to `/api/speech-to-text`
4. Server calls ElevenLabs `speechToText.convert()` with the `scribe_v2` model
5. Transcribed text is injected into the chat and auto-sent

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
