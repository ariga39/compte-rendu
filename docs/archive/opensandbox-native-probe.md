# OpenSandbox native integration probe

Date: 2026-11-17. Worktree: `feat/sandbox-replacement`.
This is an in-progress local probe, not a production acceptance report.

## Verified

Using the official 1.2.1 Python server/CLI and JavaScript SDK, Docker Engine
29.9.1, and the release-1.2.1 execd image:

- The server was started with an empty `DOCKER_CONFIG` directory. A public image
  was pulled, a sandbox created, commands executed and the sandbox deleted
  without Docker account login. Control-plane requests used a locally generated
  test API key, not a vendor account.
- CLI foreground execution streamed stdout/stderr but converted remote exit 7
  into CLI exit 1. The SDK returned exit 7 and separate exact output strings.
- SDK `onInit` supplied an execution ID. Calling `commands.interrupt(id)` stopped
  the command; its subsequent file-write did not happen and exit was nonzero.
- Official credential Vault rejects IP-address binding hosts; use a FQDN.
  Domain network rules reject `ports`; IP network rules accept them.
- Private loopback publication must be consistent with server endpoint discovery
  and sidecar readiness. The test uses loopback for both control/data planes.

The isolated environment contains no production credentials. Dummy credential
values are used to exercise Vault. Test artifacts live outside the repository.

- Native Vault injection succeeded for a scoped HTTP path to a dummy private
  upstream; an unbound path stayed unauthenticated. A second port known to be
  reachable from the host was blocked from the sandbox.
- Standard nginx reverse-proxy configuration successfully forwarded the
  credentialed request from port 80 to a loopback-only upstream on port 18300
  in an isolated network namespace. No custom credential proxy was needed.
- With Vault enabled, Python HTTPS fetched the public GitHub API using normal
  certificate validation, through the injected trust chain.
- A 262,144-byte binary evidence file was downloaded and compared byte for byte.
- A read-only host checkout mount allowed reading and rejected writing.
- SIGKILL of the isolated control-plane server followed by restart preserved
  discoverability and command execution for an already-created sandbox.
- After the credential probes, Docker reported no workload containers, egress
  sidecars or runtime volumes remaining. This is evidence of the exercised
  paths, not a guarantee about every crash point.

## Still being verified

Cancellation racing command startup, ambiguous creation, crash during deletion,
and the integrated Runner execution and cleanup paths. SDK execution
success alone does not establish these properties.

The host's DNS returns fake-IP addresses for wildcard test domains. Credential
network probes must account for that without modifying the host's DNS or
weakening the sandbox network policy.

## Adapter implication

Keep the four product operations (setup, exec, copyOut, destroy). The current
Runner transport is CLI-specific and its cancellation owns a local child
process. Official SDK execution has the needed remote cancellation and numeric
exit status; connecting it requires an explicit runtime execution/cancellation
seam rather than assuming that killing a local client kills remote work.

The implemented adapter also passed native create, readonly staging, pinned
OpenCode 2.0.32 / gh 2.98.0 execution, evidence export and Docker absence checks.
A subsequent native OpenCode invocation received the expected review JSON text
from a deterministic SSE fixture through Vault. The fixture required the real
dummy grant; the agent received only its placeholder. The egress test image
added a fixture DNS upstream because this host uses fake-IP DNS; this was test
infrastructure, not an adapter policy exception. No production credentials or
host DNS changes were involved. This proves the transport/tool runtime path,
not review quality, full Runner-to-Core publication, or production readiness.

The repository native smoke test is opt-in and takes explicit server/image/key
file/staging environment settings. The one-off model/DNS fixture and captured
test source are local-only probe artifacts. Production remains on sbx.

## Port boundary correction

A native negative test using the actual adapter proved that an allowed FQDN's
listening TCP 8081 port was reachable with the stock egress image. The earlier
IP-scoped probe did not establish the adapter's domain-policy port boundary.
The required egress image now installs the official `reachable.ports.cap`
operator floor with 80/443. Repeating the same probe blocked 8081 while the
real OpenCode/Vault SSE review fixture still completed and cleanup succeeded.
This was a real failing assertion before the image change and a passing one
afterward. The fixture DNS override is only part of the isolated test image.
