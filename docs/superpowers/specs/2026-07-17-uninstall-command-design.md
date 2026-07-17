# `uninstall` Command Design

## Goal

Add `code-review-mcp uninstall` to reverse the project-local changes made by `setup`, without removing user-owned configuration, rules, agent directories, or the npm package.

## Command Interface

- `code-review-mcp uninstall` cleans each supported agent whose project directory already exists.
- `code-review-mcp uninstall --agent <claude|devin|codex>` cleans only that agent.
- An unknown agent and a missing `--agent` value report an error and exit non-zero, matching `setup`.

## Scope

For every selected agent, the command removes only:

1. The `code-review` entry from its MCP configuration:
   - Claude and Devin: `mcpServers.code-review` in their JSON config.
   - Codex: the `[mcp_servers.code-review]` TOML section.
2. `SKILL.md` in the project-local `skills/code-review` directory.
3. The `skills/code-review` directory only when it becomes empty after removing `SKILL.md`.

It does not remove the agent directory, any other skill, a user-provided MCP entry, `.code-review/rules.json`, global rules, or the globally installed npm package.

## Architecture

`setup` and `uninstall` share the existing agent metadata and `--agent` selection behavior. `uninstall` uses format-specific configuration removal helpers:

- JSON removal reads an existing parseable config, removes only the named property, and writes the file only when that property was present. An empty `mcpServers` object remains intact to avoid reshaping user configuration.
- TOML removal deletes only the exact code-review MCP section while preserving all unrelated text.
- Skill removal unlinks only the expected `SKILL.md`; directory removal is guarded by an emptiness check.

The command reports each removal and each absent target, so rerunning it is safe and understandable.

## Error Handling

- Missing configurations, skills, or agent directories are no-ops with informative output.
- An unparseable JSON config is left untouched and reported rather than overwritten.
- Filesystem failures are reported per agent; processing continues for the remaining selected agents.

## Testing

Add CLI-level tests that execute the built command in temporary directories. Cover:

1. JSON configuration and installed skill removal.
2. TOML section removal while preserving unrelated sections.
3. `--agent` limiting cleanup to the selected agent.
4. No-op/idempotent behavior when cleanup targets do not exist.
5. Protection of unrelated MCP entries and nonempty skill directories.

Run the focused test first in the failing state, then after implementation run the full test suite and TypeScript build.
