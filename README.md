# bigpig-forge

A GitHub-compatible git forge in a single Node 22 process — smart HTTP git
(clone/push), REST v3 API (repos, issues, pull requests, contents), GraphQL
(the shapes `gh` and `github-mcp-server` send), and MCP tools, all served
from its own in-memory store. No UI, no outside service, no git binary.

Entry for make.fun bounty `github-core-clone-01` ($500): "Build a
GitHub-compatible git forge". Local grade (kit runner, practice instance):
120/120 conformance, total score 971 (house reference ≈ 900).

## Run

```sh
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port of its own, registers it with the suite,
and serves until done. Node built-ins only — nothing to install.
