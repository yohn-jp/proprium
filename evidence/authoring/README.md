# Authoring suite certification evidence

`implementation.json` is generated from the current Canon and recovery inventory by:

```sh
node scripts/build-authoring-evidence.mjs
node scripts/build-authoring-evidence.mjs --check
node --test scripts/build-authoring-evidence.test.mjs
```

It enumerates R01–R14, each plugin feature and acceptance anchor, all source actions, all 42 registered UI contributions, and the fixed 33-tool MCP surface. New or removed Canon requirements cause verification to fail until the evidence ledger is reconciled.

All implementation records initially say `NOT_CHECKED`. A record can become `PASS` only with a full Git SHA, exact fixture and command, browser/platform, exact input/output and Host receipt, source revisions, actual signed plugin and registry digests where it concerns an official product, and an archived CI/evidence URL. `BLOCKED` requires the specific missing dependency or external constraint; an attempted or unlaunched check never counts as a pass. Unit tests, source review, a build, synthetic registry builder tests, and `compute-sum` do not substitute for the signed installed product workflows in the canon.

Do not edit the generated inventory to make a check green. Add immutable execution evidence and update only the matching result fields after verifying its command, revision and archived artifacts.
