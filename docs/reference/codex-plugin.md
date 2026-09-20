---
title: Codex plugin and installed agent interface
date: 2026-09-12
type: reference
status: maintained
---

# Codex plugin and installed agent interface

The repository packages a self-contained Codex plugin at
`plugins/tibotattle`. It contributes one usage-coach skill and a local stdio
MCP server. The plugin never parses Codex sessions or owns a second ledger; it
calls the installed Electron application's versioned, read-only agent interface,
which delegates analysis to the existing local usage explainer.

This source contract is newer than the public 0.1.22 app. The plugin requires
installed agent protocol v1, whose first compatible public release must be
0.1.23 or later. Until that release is published and independently qualified,
`tibotattle_status` reports 0.1.22 as incompatible and
`tibotattle_install_plan` refuses to offer it as a solution.

## Agent data flow

```text
Codex host model
  -> bundled usage-coach skill
  -> local TiboTattle MCP server (stdio)
  -> packaged Electron companion --agent-protocol 1
  -> existing unified index and usage-explainer service (read-only)
```

Only the deterministic explainer reads private local evidence. Its compact
responses remain content-free and preserve unavailable, stale, partial and
unknown states. The host model interprets those facts and proposes measurable
experiments; TiboTattle does not embed or call an LLM.

## Tools

| Tool | Effect |
| --- | --- |
| `tibotattle_status` | Read installation compatibility and local data health. |
| `tibotattle_list_plans` | Read the live plan, pagination and claim contract. |
| `tibotattle_explain_usage` | Run one bounded plan; pass `nextCursor` unchanged to page. |
| `tibotattle_get_evidence` | Resolve one opaque evidence selector. |
| `tibotattle_install_plan` | Read the latest stable GitHub manifest and Homebrew cask, then prepare an exact expiring plan. |
| `tibotattle_install` | After explicit confirmation, consume the plan token once and install or upgrade the matching cask. |

The first five tools are read-only. Release lookup is the only network activity
among them. The install tool is separately marked write/destructive and cannot
run without the unchanged, single-use token returned by an unexpired plan.
Before Homebrew runs, the cask version and architecture-specific checksum must
still match the confirmed canonical release manifest. Afterward, the plugin
requires the installed app version and protocol handshake to match the plan.

Plugin-to-app discovery and automatic installation are intentionally macOS-only
in protocol v1. Other platforms receive an explicit unsupported result before
installation discovery or release lookup rather than an inferred path or generic
command execution capability.

When both `/Applications/TiboTattle.app` and the per-user Applications copy are
present, the plugin verifies both bundle versions and selects the latest semantic
version before checking agent compatibility. It never falls back to an older app
merely because that copy exposes the protocol. Equal versions retain
system-before-user precedence. Status reports the number of detected
installations without returning their filesystem paths.

## Installed Electron protocol v1

The packaged companion entrypoint reserves `--agent-protocol 1` followed by one
of four commands: `status`, `explain-usage-plans`, `explain-usage`, or
`explain-usage-evidence`. It accepts only the plan, period, page limit, opaque
cursor and opaque selector options required by the explainer. It does not expose
arbitrary SQL, filesystem paths, shell commands, refresh, settings or upload.

For maintainers, a production macOS status probe has this exact shape:

```text
ELECTRON_RUN_AS_NODE=1 \
  /Applications/TiboTattle.app/Contents/MacOS/TiboTattle \
  /Applications/TiboTattle.app/Contents/Resources/app.asar/apps/local/server.js \
  --agent-protocol 1 status
```

Standard output is exactly one bounded JSON record. Expected errors use fixed
content-free codes; unexpected exceptions are not echoed. Normal companion
startup remains unchanged when `--agent-protocol` is absent.

## Local plugin development

The repository marketplace descriptor is `.agents/plugins/marketplace.json`.
After validating the plugin, add this repository as a local marketplace and
install `tibotattle@tibotattle-local` with the Codex plugin commands. Installing
the plugin and installing the desktop app are distinct actions. A new Codex task
is required after plugin installation or update so its skills and tools reload.

Do not publish the plugin, install a production application, or treat a
development bundle as release evidence without the corresponding explicit
authorization and release gates.
