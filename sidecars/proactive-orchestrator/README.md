# Arcana Proactive Orchestrator

LangGraph sidecar for Arcana's proactive screen-aware workflow.

This first version intentionally uses mock Screenpipe context so the integration
spine can be tested before wiring real OCR data:

```text
mock screen context -> LangGraph -> proactive suggestion -> Arcana gateway -> Web UI
```

## Run

```bash
npm install
npm run dry-run
npm run once -- --arcana-url http://127.0.0.1:8787
```

Use `npm run loop` to poll repeatedly.

## Screenpipe Provider

Start Screenpipe first, then run:

```bash
npm run once -- --provider screenpipe --arcana-url http://127.0.0.1:8787
```

Useful flags:

```bash
--screenpipe-url http://127.0.0.1:3030
--minutes 5
--fallback-mock
```

The provider calls Screenpipe's local REST API:

```text
GET /search?content_type=ocr&limit=30&start_time=<iso>&max_content_length=1200
```

It then filters to work-related apps like VS Code, Cursor, terminals, Chrome,
and Edge, while dropping obvious private chat/payment/password windows.

The context rows use this JSON shape:

```json
{
  "timestamp": "2026-05-26T10:00:00.000Z",
  "app": "VS Code",
  "windowTitle": "arcana-main - Visual Studio Code",
  "text": "npm ERR! ...",
  "source": "screenpipe",
  "evidenceId": "screenpipe-frame-id",
  "privacyFlags": []
}
```
