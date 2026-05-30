# platform-command

A lightweight skill project for learning platform click flows, extracting APIs/parameters, and turning them into reusable commands.

## Quick start

```bash
npm install
node src/cli.js --help
node src/cli.js verify --command demo.search_example
node src/cli.js execute --command demo.search_example --dry-run keyword=abc
npm test
```

## Directory layout

```text
platform-command/
├── SKILL.md
├── README.md
├── package.json
├── src/
│   ├── cli.js
│   ├── command_store.js
│   ├── execute.js
│   ├── learn.js
│   ├── utils.js
│   └── verify.js
├── commands/
├── platforms/
├── runs/
├── templates/
├── examples/
├── docs/
└── tests/
```

## Command lifecycle

```text
learn → extract API/parameters → generate command → execute → verify → update when platform changes
```

## Command example

```bash
node src/cli.js execute --command demo.search_example --dry-run keyword=abc page=1
```

## Learn example

```bash
node src/cli.js learn --platform demo --action inspect_example --url https://example.com --observe-seconds 5
```

The command writes a timestamped report into `runs/`.

## Notes

This first version provides the skill skeleton, templates, CLI, dry-run execution, structural verification, and learn-mode observation. Real platform commands are generated after visiting a concrete platform.
