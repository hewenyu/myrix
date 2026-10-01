# First-version BFF API

All paths below are under `/api/v1`, same origin. JSON errors `{ error, reason }`; list envelopes `{ items }`. Domain wire types are exported from `@myrix/contracts` `platform.ts`. Browser never sends actor identity. Backend adapters normalize SQL names to wire fields.

## Authentication

- `GET /auth/session` -> `{ identity: PlatformIdentity, csrfToken: string, mode: "oidc" | "development" }`, or 401.
- `GET /auth/config` -> `{ mode: "oidc" | "development", loginUrl: string }` (public).
- `GET /auth/login` -> OIDC redirect.
- `POST /auth/dev-login` `{ user: "author" | "editor" | "other-tenant" }` -> authenticated session response. Available only under explicitly enabled loopback development mode; never production. These are seeded test identities, not arbitrary IDs.
- `POST /auth/logout` -> 204. All authenticated mutation requests require `X-CSRF-Token`, same-origin cookie and Origin check.

## Works

- `GET /works` -> `{ items: Work[] }` (only current owner's).
- `POST /works` `{ title, description }` -> `Work`.
- `GET /works/:workId` -> `Work`.
- `DELETE /works/:workId` -> 204 (revoke sessions before deleting associated business data).
- `GET /works/:workId/outline` -> `Outline` (initial version 0, empty text).
- `PUT /works/:workId/outline` `{ text, expectedVersion }` -> `SaveResult`.
- `GET /works/:workId/chapters` -> `{ items: Chapter[] }`.
- `POST /works/:workId/chapters` `{ title }` -> `Chapter` (version 0).
- `GET /works/:workId/chapters/:chapterId` -> `Chapter`.
- `PUT /works/:workId/chapters/:chapterId` `{ text, expectedVersion }` -> `SaveResult`.
- `GET /works/:workId/chapters/:chapterId/versions` -> `{ items: { version, text, createdAt }[] }`.
- `GET /works/:workId/bible?query=...` -> `{ items: BibleEntry[] }` (query optional).
- `POST /works/:workId/bible` `{ kind, title, text }` -> `BibleEntry`.
- `PUT /works/:workId/bible/:entryId` `{ text, expectedVersion }` -> `SaveResult`.
- A version conflict returns HTTP 409 with `{ status: "conflict", version }`; the UI must not overwrite local unsaved edits.

## Sessions

- `GET /works/:workId/sessions` -> `{ items: NovelSession[] }`.
- `POST /works/:workId/sessions` `{ preset: NovelPreset }` -> `NovelSession`.
- `POST /sessions/:sessionId/messages` `{ commandId: UUID, text }` -> HTTP 202 `QueuedCommand`.
- `POST /sessions/:sessionId/cancel` `{ commandId: UUID }` -> HTTP 202 `QueuedCommand`.
- `DELETE /sessions/:sessionId` -> 204; revokes session, cancels and disposes live Agent.
- `GET /sessions/:sessionId/events` -> SSE with event `message`, JSON `SessionStreamEvent`; only durable events carry `id: seq`. Browser native EventSource sends Last-Event-ID on reconnect. Replay of persisted messages, not transient deltas, is authoritative. Authentication is session cookie, no tokens in URL.

## UX requirements

Display explicit pending/waking, working, interrupted, revoked, model-not-configured and disconnected states. A queued acknowledgement is not a completed model reply. Do not show fabricated streaming text. Tool messages and final assistant text come from actual events. Local mock-model integration mode must visibly identify itself and never activate as a fallback.
