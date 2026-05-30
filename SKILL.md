# platform-command skill

## Purpose
`platform-command` turns repeated platform operations into reusable commands. It helps the agent autonomously learn a target platform action, inspect UI elements, capture network requests, infer parameters, generate command templates, execute learned commands, and verify results.

## Core modes

### 1. learn
Learn a new platform action.

```bash
node src/cli.js learn --platform demo --action search_example --url https://example.com --observe-seconds 10
```

The learn mode should:
- open the target page;
- observe DOM structure;
- capture network requests and responses metadata;
- identify forms, buttons, inputs, tables and success/error hints;
- write a run report under `runs/`;
- optionally generate a draft command template.

Safety: learn mode is observation-first. It must not submit destructive actions unless the user explicitly allows test submission.

### 2. extract_api
Extract and summarize candidate APIs from a learn run.

First version stores captured request metadata inside the learn report. Later versions may promote stable requests into command templates.

### 3. generate_command
Generate or update a command template under `commands/`.

A command template defines:
- command name;
- platform;
- risk level;
- parameters, defaults and validation hints;
- preferred execution path: API first, UI fallback;
- success criteria;
- failure cases.

### 4. execute
Execute a learned command.

```bash
node src/cli.js execute --command demo.search_example --dry-run keyword=abc
```

Default expectation:
- dry-run is safe and prints the execution plan;
- API execution is preferred when all API metadata is available;
- UI execution is fallback;
- high-risk commands require explicit confirmation.

### 5. verify
Verify a command template is structurally valid.

```bash
node src/cli.js verify --command demo.search_example
```

## Safety rules
- Never store secrets, raw cookies or raw authorization headers in command files.
- Record only token field names and sources unless user explicitly authorizes secure local storage.
- Default to dry-run for unknown or high-risk actions.
- Treat deletion, payment, refund, batch update, permission change and external messaging as high-risk.
- Success means business result verified, not merely button clicked.

## Result principle
Every command should eventually answer:
1. What parameters were used?
2. Which execution path was used: API or UI?
3. What evidence proves success?
4. What failed and where, if it failed?
