# Tura behavioral specification

This adapter drives the source-built Tura CLI, configured through `CODOR_TURA_BIN`
(the pinned `tura` binary). It was written from Tura's first-party source and docs
plus direct no-model probes of the running gateway.

## Sources checked (2026-07-22)

First-party Tura sources (in the Tura checkout):

- `docs/start/sessions.md` — session/turn lifecycle. A turn's terminal status is one
  of `completed`, `failed`, `timeout`, or `permission_required`; a session may sit in
  `idle`, `busy`, or `error`, where `error` means "the last turn failed, was cancelled,
  or was interrupted".
- `apps/tui/src/output/ndjson.ts` — the `run --output ndjson` emitter. Terminal event
  is `{ "type": "cli.completed", ...RunResult }`; a thrown error becomes
  `{ "type": "cli.failed", "error": <message> }`.
- `apps/tui/src/types/session.ts` — `RunResult.status: "completed" | "failed" |
  "timeout" | "permission_required"`, plus `finalText`, `usage`, `metadata`.
- `apps/tui/src/commands/run.ts` — completion decision. Polling/streaming resolves the
  turn from the **session** status: `status === 'idle' && hasNewAssistant →
  buildRunResult(..., 'completed')`; **`status === 'error' && hasNewAssistant →
  buildRunResult(..., 'failed')`**. `buildRunResult` sets `finalText =
  lastAssistantText(messages)`. A deadline with no terminal session state throws a
  `TimeoutError("timed out after Ns")` → `cli.failed`.

No-model probes: `tura --json config model-tiers`, `tura --json session list --all`,
`tura session show <id> --json`, and one real `run --output ndjson` turn confirming
`cli.completed status:"completed" finalText:"…"` on a clean turn.

## Invocation

New turn / continued turn (`turaArgs`):

```text
tura --cwd CWD run --zsh --output ndjson --agent-id ID --session-type coding \
     --timeout 3600 [--model PROVIDER/MODEL] [--model-variant LEVEL] \
     [--session SESSION_ID] PAYLOAD
```

`--zsh` selects the gateway-owned command-run surface (the proven headless contract);
the plain run surface can complete the model turn and then return a nonzero runtime
status. `--timeout 3600` overrides Tura's implicit per-invocation ceiling so a healthy
long turn is not cut mid-checkpoint. Stdin is `ignore`d, the process is spawned
`detached` (own process group), stdout is read line-by-line through EOF, and stderr is
bounded (last 8 KiB) for failure detail. `session.env` is merged over `process.env`.

## Resume, discovery, models, attach

- **session_ref**: the first non-empty `sessionID` seen on the stream becomes the
  member's `session_ref`; resume passes it to `--session` from the same cwd.
- **discovery**: `tura --json session list --all` → root session ids.
- **models**: `tura --json config model-tiers` → `{provider}/{model}` from the `fast`
  and `thinking` tiers; `listModels()` reports `source: 'discovered'`.
- **attach / abort**: `interrupt()` runs `tura --json session abort SESSION_ID`, then
  SIGKILLs the process group if it has not exited within `ABORT_GRACE_MS`.

## Event normalization

| Tura ndjson event | Codor event |
| --- | --- |
| `cli.started` | capture session id; no visible item |
| `message.part.delta` | ignored (partial/reorderable; final comes from the update) |
| `message.updated` (assistant) | accumulate final assistant text; mark terminal activity |
| `command.updated` | `run.item/tool_call`, then `run.item/tool_result` on a terminal command status |
| `session.status` = `idle` (after terminal activity) | `run.completed` = completed |
| `cli.failed` | `run.completed` = failed (error = reported message) |
| `cli.completed` | mapped by status — see below |
| stream EOF, then process exit | `run.completed` from exit code (0 → completed, nonzero → failed, else interrupted) |

### `cli.completed` status mapping (the load-bearing contract)

`RunResult.status` is one of four values, and `finalText` is *always*
`lastAssistantText` — never an error string. Tura returns **`failed` with the finished
answer in `finalText`** whenever the native session momentarily reached `error` during
the turn (a retried or cancelled sub-call). That is routine on tool-heavy turns and is
NOT a real failure. A naive `status === 'completed' ? completed : failed` therefore
blanks a valid answer and kills the member. The adapter maps by real semantics:

| `cli.completed.status` | `finalText` | Codor `run.completed` | Why |
| --- | --- | --- | --- |
| `completed` | any | `completed` | clean turn |
| `failed` | non-empty | `completed` | session soft-errored; the produced answer is the turn's real output |
| `failed` | empty | `failed` (synthetic error) | no answer produced — a genuine failure |
| `timeout` | any | `interrupted` (answer preserved) | turn cut short by the deadline |
| `permission_required` | any | `interrupted` (answer preserved) | turn paused awaiting permission; Tura's `run` has no response channel |

`cli.failed` and the nonzero-exit / EOF path are unchanged, so a true process failure
still preserves its stderr/exit detail rather than being masked by earlier assistant
text.

## Lifecycle: terminal event, grace, reap

`deliver()` reads stdout until it closes. Once the translator yields a terminal
`run.completed`, the turn is done from Codor's perspective; Tura sometimes lingers in
native session/checkpoint cleanup and occasionally never exits, holding stdout open. A
`TURA_TERMINAL_GRACE_MS` timer (armed only on a real `run.completed`, not tool
completion or an early idle) then SIGKILLs the detached process group so the async
iterator finishes and Codor persists the already-emitted turn. The timer is cleared if
the child exits first, so a checkpoint written shortly after the terminal event still
lands.

## Capability truth

| Capability | Declared | Evidence |
| --- | --- | --- |
| resume | true | documented `run --session`; argv + stable-id tests |
| discover | true | `session list --all` JSON; parser test + live store check |
| interactive attach | true | native session resume; abort probe |
| ask | false | `run` exposes no question response channel (`respondInteraction` rejects) |
| approvals | runtime | policy tiers declared, native mapping unverified (all `null`) |
| extensions | false | no authoritative child lifecycle from the stream |
| thinking | true | `low/medium/high/xhigh/max` → `--model-variant`; argv tests |

Policies are declared `read-only: null, workspace-write: null, full-access: null`
until a real Tura policy mapping is verified — the argv is identical across tiers, so
the UI is told the truth (not enforced) rather than a mapping that does not exist.
