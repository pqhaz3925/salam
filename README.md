# salam

A local-first terminal coding harness with subscription-backed models, native development tools, SSH workspaces, and agents that can talk to each other.

Session history and project memory are stored on the machine running salam. Their content can be included in requests to your selected model provider: local-first does not mean offline inference.

> **Not a sandbox.** Commands and tools run with your user permissions, without an approval gate. Only use trusted repositories, provider endpoints, and MCP servers. File freshness checks help protect concurrent edits; they do not make arbitrary shell commands safe.

## What it does

- **Native file and code tools:** paged reads, regex and AST search, guarded writes and edits, multi-file batch edits, and directory operations.
- **Language-aware development:** LSP diagnostics, symbols, hover, call hierarchy, renames, and code actions; staged AST rewrites; DAP debugging; persistent JavaScript and Python execution.
- **Local and SSH workspaces:** the same filesystem, search, shell, LSP, and debugging interfaces on the active host.
- **Communicating agents:** background tasks, parent/child and peer messaging, shared checkouts or isolated Git worktrees.
- **Persistent conversations:** resume, model switching without discarding the dialog, checkpoints, file rewind, and session diffs without Git.
- **Project memory:** a bounded `MEMORY.md` index loaded at startup, with topic files read on demand.
- **MCP and web tools:** on-demand MCP schemas, provider-native page fetching, and a separate web-search model that returns sourced summaries.
- **Long-running work:** persistent goals, periodic idle-time tasks, and supervised foreground/background commands.

## Install from source

Requirements:

- **Bun 1.4.1 or newer.** The checkout also installs a pinned local Bun runtime.
- **Node.js** for the `bin/salam` launcher and Node-based tools. JavaScript `eval` requires Node.js 22 or newer.
- **Git** to clone the repository and use isolated worktrees. Ordinary file tracking and rewind do not depend on Git.
- **ripgrep (`rg`)** on `PATH` for text search. AST search and the TypeScript language server are bundled.

```sh
git clone https://github.com/pqhaz3925/salam.git
cd salam
bun install --frozen-lockfile

# Make this checkout's launcher available in the current shell.
export PATH="$PWD/bin:$PATH"

salam auth
# If no usable Anthropic login is available:
salam login anthropic

salam --cwd /path/to/your/project
```

You can also use `./bin/salam` directly, or run from source with:

```sh
bun run start --cwd /path/to/your/project
```

The package is currently private and intended to run from a checkout; these instructions do not rely on an npm registry release.

Additional tools are installed on the host where they run:

| Feature | Additional requirement |
| --- | --- |
| SSH workspace | SSH access to a POSIX host with Python 3; search and language-server executables on its `PATH` |
| Non-TypeScript LSP | The corresponding server, such as `gopls`, `rust-analyzer`, `clangd`, or `pyright` |
| Python `eval` | Python 3.8+ |
| SQLite reads | Python 3.11+ |
| Debugging | `debugpy`, `lldb-dap`, or a configured stdio DAP adapter |
| MCP server | That server's executable/runtime and any required credentials |

## Run and authenticate

```sh
salam                                  # Terminal interface
salam -p "Explain the architecture"     # One task; final text on stdout
salam -p "Find the bug" --json          # Newline-delimited JSON events
salam --resume latest                   # Continue the latest saved conversation
salam --resume ID                       # A unique ID prefix also works
salam sessions
salam models
salam auth
salam recovery                          # Retained file-recovery entries (see below)
salam --help
```

File writes are atomic and keep the file they replace (the displaced inode, which another editor may still have open) in an owner-private recovery directory outside the working tree: the user cache, a volume's `.salam-recovery-UID`, or the repository's `.git/salam-recovery-UID`. Nothing is pruned automatically, and writes are refused once a directory holds 1024 entries. `salam recovery` lists them (marking any a process still has open); `salam recovery prune entry-N ...` or `salam recovery prune --older-than 14d` removes them, skipping open ones unless `--force`.

Interactive mode requires a terminal. Use `-p` for non-interactive execution; `--json` requires `-p`. Slash commands also work in one-shot mode, for example:

```sh
salam --resume latest -p "/usage session"
```

Built-in provider integrations are **Anthropic**, **OpenAI Codex**, and **Devin**:

```sh
salam login anthropic
salam login openai-codex
salam login devin
salam --model anthropic/claude-fable-5-1
```

Use `salam models` for available `provider/model` identifiers. Custom OpenAI-compatible and Anthropic-compatible endpoints are also supported.

Credential reuse is provider-specific:

- Anthropic can reuse Claude Code's macOS Keychain login. On other platforms, use salam's own login flow.
- Codex can obtain credentials through an installed OMP token broker; otherwise use `salam login openai-codex`.
- Devin can read the official Devin CLI's credentials. Public Devin agent-session API keys are not inference credentials.
- Custom endpoints use a configured environment variable rather than `salam login`.

`salam auth` reports availability and credential source, never token values. Credentials saved by salam live in its private state directory.

## Terminal controls and sessions

| Control | Action |
| --- | --- |
| Enter | Submit; queue a message if a turn is running |
| Shift+Enter / Alt+Enter | Insert a newline |
| Ctrl+Enter / Ctrl+G | Interrupt and send the new instruction, retaining earlier queued messages |
| Esc / Ctrl+C | Cancel; Esc closes an open menu first |
| Ctrl+B | Move a running foreground shell command to the background |
| Ctrl+O | Expand or collapse complete tool output |
| Mouse wheel / PgUp / PgDown | Scroll history |
| Ctrl+End | Return to live output |

Useful commands:

| Command | Purpose |
| --- | --- |
| `/model [provider/model]` | Choose or switch model within the same dialog |
| `/effort [off\|low\|medium\|high]` | Set reasoning effort for subsequent requests |
| `/sessions`, `/resume [ID\|latest]`, `/new` | Inspect, resume, or start conversations |
| `/rewind [ID [conversation\|files\|both]]` | Choose a checkpoint and restore mode |
| `/recap [focus]` | Summarize without replacing the working context |
| `/compact`, `/context` | Compact or inspect context |
| `/usage [session\|provider\|all]` | Recorded usage, cache statistics, estimates, and available quota windows |
| `/agents`, `/todo` | Inspect agents and the current plan |
| `/memory [on\|off\|list]` | Inspect or configure automatic project memory |
| `/tools [enable\|disable NAME…]` | Inspect or change enabled tools |
| `/remote NAME\|local` | Start a new session on the selected workspace |
| `/goal TEXT` | Work toward a persistent goal |
| `/goal status\|pause\|resume\|clear` | Inspect or control the goal |
| `/loop [INTERVAL] TASK` | Run periodically while idle; default interval is 10 minutes |
| `/loop list`, `/loop stop ID`, `/loop stop all` | Inspect or stop loops |
| `/jobs`, `/output ID`, `/wait ID [SECONDS]`, `/kill ID` | Manage background commands |
| `/help`, `/quit` | Show help or exit |

Each model retains its own native context and cache key when you switch away and back. Cache hits still depend on provider retention. Usage costs are catalog estimates, not subscription invoices.

Goals reload paused when a session is resumed. Loops do not overlap or accumulate a backlog and are removed on session changes or exit. Normal shutdown stops owned background commands; supervisors support job recovery after a crash.

## Configuration

Configuration is loaded in this order, with later values taking precedence:

1. `<home>/config.json`, where home defaults to `~/.salam`.
2. `<cwd>/.salam/config.json`.
3. An explicit `--config PATH` file.

`providers`, `mcpServers`, and `remotes` merge by entry name. Other top-level settings use the later value. Unknown settings are rejected.

- `--home` overrides `SALAM_HOME`, which overrides the default state directory.
- `--model` overrides `SALAM_MODEL`, which overrides the configured model.
- `--cwd` selects the project working directory.

A minimal configuration:

```json
{
  "model": "anthropic/claude-fable-5-1",
  "webSearchModel": "openai-codex/gpt-5.6-luna",
  "reasoning": "medium",
  "maxAgents": 4,
  "autoMemoryEnabled": true
}
```

Leave `contextThreshold` unset to use the active model's context window automatically, reserving `maxOutputTokens` plus a 4,096-token safety margin. An explicit `contextThreshold` adds an absolute token cap; it cannot exceed that model-aware budget. Cached tokens still occupy context space even when the provider reuses them.

See [configuration loading and validation](src/config.ts) and [configuration types](src/contracts.ts) for the complete contract.

### Custom model endpoints

Set `LOCAL_API_KEY` in your environment and configure the endpoint and its models:

```json
{
  "model": "local/coding-model",
  "providers": {
    "local": {
      "kind": "custom-openai",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "apiKeyEnv": "LOCAL_API_KEY",
      "models": [{ "id": "coding-model", "contextWindow": 128000 }]
    }
  }
}
```

Use `custom-anthropic` for an Anthropic-compatible endpoint. Keep credentials in environment variables, not committed configuration.

### SSH workspaces

```json
{
  "remotes": {
    "dev": {
      "host": "devbox",
      "cwd": "/srv/project"
    }
  }
}
```

Then run `salam --remote dev`. Configure SSH authentication and known hosts normally: host-key verification remains enabled. Remote working directories must be absolute POSIX paths.

The user command `/remote dev` starts a new session. The agent-facing `workspace_switch` tool instead changes only that agent's target while preserving its conversation and leaving other agents on their own targets.

### MCP servers

For example, add a Playwright MCP server:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

Stdio servers use `command`, `args`, and optional `env`; Streamable HTTP servers use `url` and optional `headers`.

The model sees `mcp_list` and `mcp_call`, not every server's full schema in the baseline prompt. It discovers available tools, loads the selected tool's schema on demand, then calls it. Resources and prompts are available through the same MCP interface. Failed servers remain visible with their connection errors.

### Web access

`web_fetch` uses native Anthropic or Codex page fetching. `web_search` uses the separate `webSearchModel`, without sending the working conversation, and returns a sourced summary.

The default search model is `openai-codex/gpt-5.6-luna`. It needs Codex authentication even when the main conversation uses Anthropic or another provider. Search usage is recorded separately from the conversation's context-window usage.

## File safety, checkpoints, and agents

Native mutations check the file state the calling agent last observed, or an explicitly supplied expected hash, rather than silently overwriting an intervening edit. A successful `file_ops move` carries that known state to the new path. Occupied destinations are refused explicitly. Destructive directory operations require a reviewed tree hash from `file_ops inspect`; a stale hash requires a new inspection.

`checkpoint`, `/rewind`, and `session_diff` use salam's mutation journal, not Git:

- Native filesystem changes and LSP workspace edits are tracked, including supported directory operations on local and SSH workspaces.
- Shell commands, direct filesystem writes from `eval`, and MCP writes are **not tracked**. Calling native tools through `eval` uses the normal tracked tool path.
- Rewind refuses conflicting external changes rather than overwriting them. Stop background commands before requesting file rewind.
- Conversation rewind forks history and keeps the original branch. File-only rewind leaves the conversation intact.
- `session_diff` counts distinct paths separately from change segments: interleaved edits can produce several segments for one path.
- Native mutation/checkpoint capture is limited to 8 MiB per file. Checkpoint capture and restore refuse symlinks.

Diagnostics are findings, not execution failures: a complete `lsp_diagnostics` report succeeds even when it contains code errors. Failed or incomplete scans are reported separately as tool errors.

Agents can exchange messages with their parent and peers. By default, an agent spawned inside a Git working tree uses a real isolated worktree; outside Git it shares the checkout. Explicit isolation requires a **clean** Git checkout. Salam never automatically stashes or commits your changes. Shared-checkout mode is also available explicitly.

## Project memory

Automatic memory defaults to `<home>/projects/<project-key>/memory`. Git worktrees share their project's memory. SSH project memory is stored locally on the machine running salam, not on the SSH host.

- The first 200 lines / 25 KiB of `MEMORY.md` load at session startup.
- Topic Markdown files are read on demand through the `memory` tool.
- `/memory off` disables automatic recall and memory writes; inspection remains available.
- `SALAM_DISABLE_AUTO_MEMORY=1` forces memory off regardless of saved settings.
- `autoMemoryDirectory` may be set in the home configuration or an explicit `--config` file, but not in project configuration.

Project memory is separate from per-session context notes and conversation history.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test          # full suite, test files in 5 parallel workers (~35s), on the pinned Bun (a bare `bun test` may pick an older global Bun and is refused)
bun run test:serial   # the same suite in one process (~110s), for debugging cross-file interference
bun run test:fast     # parallel, skipping the slow process-supervisor and eval-kernel suites
bun run lint          # Biome lint + format check (clean; `bun run format` fixes formatting)
bun run build
bun run format
```

The build produces `dist/cli.js` and third-party notices. Run it with:

```sh
bun dist/cli.js --help
bun dist/cli.js --cwd /path/to/your/project
```

This is a Bun bundle with external dependencies, **not a standalone executable**. Keep the installed dependencies available. The `bin/salam` launcher continues to run source with the OpenTUI preload.

| Path | Responsibility |
| --- | --- |
| [`src/cli.ts`](src/cli.ts) | CLI entrypoint and help |
| [`src/providers/`](src/providers/) | Credentials, model catalogs, and provider requests |
| [`src/runtime/`](src/runtime/) | Sessions, agents, checkpoints, worktrees, and goals |
| [`src/tools/`](src/tools/) | Native local/SSH tools and process management |
| [`src/integrations/`](src/integrations/) | MCP, memory, and web integrations |
| [`src/ui/`](src/ui/) | Terminal UI |
| [`test/`](test/) | Regression and integration tests |

For bugs, include reproduction steps and relevant output in an [issue](https://github.com/pqhaz3925/salam/issues). Redact credentials and private project data.

## License

Copyright (C) 2026 Pavel Mikhailovin.

salam is free software licensed under the [GNU Affero General Public License v3.0](LICENSE). If you modify it and make it available to users over a network, you must also offer them the corresponding source code.
