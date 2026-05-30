# Creating a new command

1. Run learn mode on the target page.
2. Inspect `runs/<timestamp>_platform_action/learn_report.json`.
3. Copy `templates/command-template.json` to `commands/<platform>.<action>.json`.
4. Fill parameters, execution API/UI paths, success criteria and failure cases.
5. Run `node src/cli.js verify --command <platform>.<action>`.
6. Run dry-run execution before any real execution.
