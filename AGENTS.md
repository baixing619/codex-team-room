# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Product decisions

- The selected visual source is `../design-reference-option-1.png`. Preserve its light, conversation-first three-column layout, restrained indigo accent, generous spacing, compact member roster, and inline command approval card.
- The visual selection does not reduce product scope. Knowledge base, shared consensus, project and thread import, member role/model configuration, automatic participation decisions, and safe command approval remain required.
- Treat local Codex data as private. Never commit session transcripts, authentication files, API keys, `.env` files, SQLite databases, or imported user project content.
- This project is intended for public open-source release. Use original implementation and assets, keep dependency licenses auditable, and add attribution or notices for every redistributed third-party file.
- When a user provides `CODEX_SETUP.md`, treat it as the supported first-run workflow. Ask for the exact downloaded project directory before installing anything, verify the project identity, request one explicit confirmation, then follow the file's local setup and owner-only Sites deployment instructions.
- A private Sites deployment and the local Codex bridge are separate trust zones. Pair them only with an owner-only site, D1 queue, owner identity allowlist, per-device secret, and a site-specific SIWC bypass token stored under the gitignored `.team-room/` directory. The local agent must poll outbound; never open an inbound computer port.
- `CODEX_SETUP.md` is expected to produce a working phone-to-local pairing for downstream users, not just deploy a static page. Verify heartbeat, queued task dispatch, reply events, one-time approval routing, and owner-only access before reporting setup complete.
