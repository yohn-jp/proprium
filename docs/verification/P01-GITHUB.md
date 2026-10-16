# P01 real GitHub persistence check

This focused check ran against runtime tree `4ee62b639bd0d18f229d55bd6bc4a0c32cd42b5f` with Core source at `655e5acf7ce43567e1e5937dd83a5e0d90eedbe7`. It used an authorized disposable private repository containing only synthetic manuscript fixtures. No credential or manuscript body is recorded here.

Actual GitHub repository metadata, clone, fetch and default-branch push passed. The check created one author-approved metadata operation, retained it as a pending checkpoint while the remote snapshot still lacked the new file, then confirmed publication. It removed the entire local data directory, registered a new clone, verified stable numeric repository identity, reconstructed the batch receipt from Git, and replayed the operation without another commit.

- Repository identity: `1422381608`; default branch: `main`.
- Checkpoint commit: `e6d5e7ceffa75ed3015d8c11684cef8e7d360242`.
- Confirmed and reconstructed remote commit: `ac8d6a4ba44a0b379d0bf158472be2ef4a169208`.
- Operation ID: `ef31333e-b745-401b-941d-6f6a82e9c654`.
- Batch ID: `batch-ef31333e-b745-401b-941d-6f6a82e9c654`.

The reusable driver is `scripts/verify-github.mjs`. After building, run it with `SCRIPTORIUM_ACCEPTANCE_GITHUB_URL` pointing to an authorized disposable synthetic GitHub repository. It uses `SCRIPTORIUM_GITHUB_TOKEN`, falling back to an existing `gh auth token` session, without printing credentials. Optional `SCRIPTORIUM_ACCEPTANCE_RESULT` writes the non-secret JSON result. This driver commits and pushes synthetic metadata to the fixture's default branch.

This proves the listed Core boundary only. It does not certify browser recovery, OCI replacement, a composed module's data round trip, or later Core changes. The original executed driver was local; the committed driver preserves that protocol with configurable paths. Full delivery must repeat affected acceptance against its final runtime tree.
