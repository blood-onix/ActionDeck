# Changelog

All notable changes to ActionDeck are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First public release.

### Added

- **Dashboard**: pick a repository, see local and remote workflows side by side, group them into virtual folders (`# @folder:` comments or name prefixes), and track run metrics.
- **Run inspection**: per-attempt jobs, steps and logs (each log segment capped at 2 MB or 10,000 lines), with cancel and re-run controls.
- **Pipeline drawer**: click a workflow to see its pipeline. Double-click, Cmd/Ctrl+click or "Open in a tab" opens it in its own editor tab.
- **Workflow Companion**: local YAML diagnostics, CodeLens and editor-title actions, validated `workflow_dispatch` runs against remote refs, and batch dispatch of several workflows.
- **Release plans**: saved release plans per repository, with steps that run in order or together, a continue rule per step, optional waits and confirmations before a step, editing before the plan starts, retry after a failure, recovery after a crash or reload, and local scheduling while VS Code is running.
- **Action Center**: run notifications, pending deployment reviews, opt-in auto-approval rules (off by default), and read-only views of environments, variables, secret names and self-hosted runners. Approval notifications open the run itself with Approve / Reject beside its jobs and logs.
- **Live run inspection**: an open run refreshes while it is active, at an interval you choose (`actiondeck.runRefreshInterval`, 30 seconds by default).
- **Team reviewers**: optional `read:org` access so GitHub recognises you as a member of a reviewer team, and **ActionDeck: Show GitHub Access** to check the account and scopes in use.
- **Copilot tools (optional)**: language model tools for explaining failed runs and proposing YAML fixes. Every action that changes something asks for confirmation first.
