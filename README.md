# opencode-bridge

A local bridge server that exposes an OpenAI-compatible chat-completions API and proxies requests through browser-based LLM chat UIs (for example, ChatGPT web).

## Project status

This repository is currently in **refactor mode** to become open-source-ready with:

- clearer contribution workflows,
- repeatable tests and CI,
- consistent project conventions.

## Features

- OpenAI-compatible endpoints:
  - `GET /health`
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - `POST /v1/chat/new`
- Streaming and non-streaming responses.
- Tool-call marker extraction/parsing support.
- Playwright-driven browser automation backend.

## Requirements

- Node.js 20+
- npm 10+
- Chromium installed for Playwright (`npm run install-browsers`)

## Quick start

```bash
npm ci
npm run install-browsers
npm start
```

Server defaults are defined in `config.js`.

## Development

### Scripts

- `npm start` — start bridge server.
- `npm test` — run unit tests.
- `npm run check` — run JavaScript syntax checks.

### Run tests locally

```bash
npm test
```

## Project structure

- `bridge-server.js` — server entry point.
- `browser-controller.js` — browser automation lifecycle and page interaction.
- `conversation-manager.js` — request orchestration and chat response handling.
- `file-block-parser.js` — parsing helpers for tool/file marker blocks.
- `test/` — unit tests.
- `.github/workflows/ci.yml` — CI pipeline.

## Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening pull requests.

## Security

Please report vulnerabilities per [SECURITY.md](./SECURITY.md).

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
