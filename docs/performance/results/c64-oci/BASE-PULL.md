# C62 pinned Node base pull

Read-only isolated-store inspection found the default runtime target's pinned Node
base absent before this pull. The authorized pull completed successfully on
2026-10-20 UTC, with CPU affinity 12–15, using the task-local Podman wrapper and
its `/data/scriptorium-c64-oci` graphroot, runroot, and temporary directory. The
five-minute timeout did not fire. No image build or container run was performed.

Requested reference:

```text
docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
```

The isolated store reports image ID
`a797d6440ed0b09e51fb884f30e47ec14cbf58482c5e19db681a0cb8df45b089`, manifest
digest `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`,
platform `linux/amd64`, and local image size 235,638,438 bytes. Podman did not
report compressed transfer bytes. `/data` free space moved from 90,763,280,384
bytes before the pull to 90,493,227,008 bytes afterward (270,053,376 bytes less
free); this filesystem delta is not a network-transfer measurement.

The pull log is at
`/data/scriptorium-c64-oci/evidence/base-pull-20261020T172648Z.log` (760 bytes,
SHA-256 `b46c14377d645210d740ad2138a02bb7e8dc787aa8d3ec8897ae68b8f7b27410`).
The configured reject-by-default policy at
`/home/sophia/.config/containers/policy.json` still has SHA-256
`0ab20a9a08e3a9c7ae6593bc83f23806d4121ecf558ffef1f6d229650d0e1042`; no trust
configuration was changed.
