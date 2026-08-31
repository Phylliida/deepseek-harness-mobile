# Agent Note: Sandbox device passthrough — GPU access as validated provider config

Status: implemented

English | [中文](2026-08-31-sandbox-device-passthrough.zh.md)

## Problem

The local sandbox's Linux profiles keep device nodes away from confined commands: bwrap builds a minimal `/dev` tmpfs (null, zero, full, random, urandom, tty, pts, ptmx, shm), and the Landlock profile's only read-write device grant is `/dev/null`. GPU work — CUDA compute, NVML queries, DRM render — therefore fails under every mode, and the operator's only escapes were approving one escalation per denied command or running the whole session under `danger-full-access`, which abandons the file-effect boundary when only a handful of device nodes were needed.

## Decision

`dsh-sandbox-local` accepts `devicePassthrough: string[]`: host device nodes exposed read-write inside every confined command. The bwrap rung appends one `--dev-bind <node> <node>` pair per entry, the Landlock rung one `--rw` grant per entry (the launcher's non-directory rule keeps `LL_FS_IOCTL_DEV` on ABI ≥ 5, so ioctls on render and compute nodes work), and a configured `runnerCommand` receives the same bwrap pairs. The Seatbelt and windows-acl rungs ignore the list — neither platform exposes GPUs through writable device nodes.

Entries are validated at plugin load: each must be an absolute path that normalizes beneath `/dev/` — rejecting `/dev` itself, since a whole-tree bind would expose `/dev/shm`, `/dev/pts`, and every unrelated node, and rejecting `..` escapes such as `/dev/../etc/hostname` — and must exist on the host. Violations throw at mount, per the fail-loud misconfiguration rule; a node that vanishes after load fails the wrap through the runner's own fatal dialect (bwrap's `Can't find source path`, the launcher's `cannot open rule path`), which consumers already classify as sandbox failure rather than command failure.

The grant is mode-independent by construction: the modes govern file effects on the ordinary tree, while device nodes are host capabilities the deployment opted into. `read-only` still fences everything else, and the in-process fs fence (`dsh-fs-sandbox`) is untouched — fs tools still cannot write device nodes. Runner selection, probing, caching, and denial semantics remain as in [the sandbox Agent Note](2026-07-06-sandbox.md).

## Alternatives considered

- **Whole-`/dev` passthrough** (`--dev-bind /dev /dev`): one line and vendor-agnostic, but it hands confined commands `/dev/shm` (every host process's shared memory), `/dev/pts`, and nodes for hardware the task never touches — a much wider boundary than GPU access requires.
- **A `gpu: true` preset**: hardcodes one vendor-and-count-specific node list into the plugin, against the no-hardcoded-tunables rule; node sets differ across NVIDIA, AMD (`/dev/kfd`), Intel, and MIG configurations, so the explicit list is the honest contract.
- **A per-call `SandboxPolicy` field**: device access is a deployment property, not a per-call decision; the policy carrier exists for mode and root, which genuinely vary per call, and no consumer requests per-call device control.
- **The `runnerCommand` wrapper escape hatch**: an operator script can inject `--dev-bind` flags with zero code changes, but it skips probing, reimplements profile assembly in shell, and exists to certify custom runners — not to carry a mainstream GPU need.

## Consequences

GPU commands (CUDA, `nvidia-smi`, VA-API render) run confined with no escalation prompts once a deployment lists its nodes; enumerating the host's `/dev` stays the operator's responsibility, verified at mount. The boundary deliberately widens for the listed nodes in every mode, including `read-only` — recorded as a known limitation in the package README. Load-time existence validation means a host whose GPU nodes appear only after a lazy module load must mount the plugin after they exist. Unit tests pin the argv dialects and every validation arm; a real-bwrap e2e proves node visibility on GPU hosts and self-skips elsewhere.
