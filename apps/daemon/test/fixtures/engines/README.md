# Engine stream fixtures

- `claude-success.jsonl`: a real Claude Code 2.1.327 `-p --output-format stream-json --verbose` run, sanitized. Hook events and local paths were removed, and only the fields the adapter parses were kept.
- `claude-limit.jsonl` and `claude-auth.jsonl`: built from the real event shapes. They carry a rejected `rate_limit_event` and an `is_error` result, with representative error text.
- `agy-success.jsonl`: a real Antigravity CLI 1.5.11 `-p --output-format stream-json` run, with local paths sanitized.
- `codex-success.jsonl`, `codex-limit.jsonl`: built from the documented contract in `codex-rs/exec/src/exec_events.rs`. Codex isn't installed on the development machine.
- `codex-rollout.jsonl`: a trimmed Codex 0.172.0 session rollout (`~/.codex/sessions/…/rollout-*.jsonl`) with the real `turn_context` / `token_count` + `rate_limits` shapes; ids, paths and numbers changed.
- `gemini-*.jsonl`: built from the contract in gemini-cli `packages/core/src/output/types.ts`. Gemini CLI isn't installed on the development machine.

Re-record the constructed fixtures from real runs once those CLIs are available.
