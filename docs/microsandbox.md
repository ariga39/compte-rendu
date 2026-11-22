# Running reviews with microsandbox

This optional Runner backend runs a local KVM microVM for each job. It requires
Linux with accessible KVM, the managed HTTPS inference relay, and a locally
loaded review image. The tested CLI is microsandbox 0.7.16 on x86-64. Download
the release for the Runner architecture, verify its published checksum and
install its bundled runtime libraries. [Upstream release](https://github.com/superradcompany/microsandbox/releases/tag/v0.7.16)

## Prepare the Runner account

Set a persistent absolute `MSB_HOME` for each instance. Run these commands as
the service account, with the same environment and access to `/dev/kvm` as
the systemd unit. Make the bundled library available to the dynamic loader
(or set `LD_LIBRARY_PATH` in the service environment).

Build the review image on a Docker build host and transfer the saved archive
to the Runner. Use a versioned tag for the image you intend to deploy.

```sh
docker build -f apps/runner/openshell-template/Dockerfile -t compte-rendu-review:local .
docker save -o review.tar compte-rendu-review:local
```

```sh
export MSB_BACKEND=local
export MSB_HOME=/absolute/path/to/instance/microsandbox
msb doctor
msb load -i review.tar
msb image inspect compte-rendu-review:local
```

Set `MSB_HOME`, `RUNNER_SANDBOX_RUNTIME=microsandbox` and
`MICROSANDBOX_IMAGE=compte-rendu-review:local` in the Runner environment.
Set `RUNNER_SANDBOX_CLI` if `msb` is outside the service's PATH.
Keep the instance's existing HTTPS relay and callback settings. Runner checks
host readiness and local image availability before taking work. VM creation
uses the cached image and requires no Docker registry account.

If a trusted transparent proxy returns Fake IP addresses, set
`MICROSANDBOX_ALLOW_FAKE_IP=1` to use the single-tenant deployment profile
and disable DNS rebinding protection. Use this only with trusted DNS and
operator-controlled GitHub and relay destinations. The guest still uses
restricted security, deny-by-default egress and the two host/443 rules. With
the option unset, Runner uses multi-tenant and keeps rebinding protection.
Both profiles cap each VM at 1,024 TCP connections and 1,024 UDP relay sessions.

## Isolation and operation

Runner requests 4 CPUs, 8 GiB memory and a two-hour VM lifetime per review.
Size aggregate concurrency across instances for the host's physical memory.
Runner presents the read-only checkout and private configuration mounts to guest UID/GID 1000 and executes as UID 1000. This preserves the host service account’s ownership and directory permissions.
The host injects the job grant and GitHub read token into authorization headers
for their respective destinations. The host CLI receives the values in its process environment, so its OS account must be trusted. The VM receives placeholders. Its DNS and TCP 443 allow rules are scoped to the relay and api.github.com. GitHub token rotation updates the live
VM through the local CLI. Runner copies evidence out before teardown.

Drain the instance and wait for confirmed cleanup before switching its backend.
Start with one review and confirm its verdict, archived evidence and destroyed
cleanup. To roll back, drain microsandbox work first, then restore the previous
Runner runtime settings and restart the unit.

For a failed cleanup, use the same account, local backend and original
`MSB_HOME`. Check the exact manifest name with `msb inspect --format json
<sandboxName>`. If an operator has confirmed ownership and stopped the job,
`msb rm -f <sandboxName>` removes that VM. The authenticated
[cleanup recovery operation](operations.md) requires an explicit absence result
from the original catalog. Moving or replacing its database invalidates this
proof, even if the replacement catalog is empty.

To run the native adapter test on a prepared KVM host, set
`CR_MICROSANDBOX_NATIVE_IMAGE` to the locally loaded tag and run
`corepack pnpm exec vp test tests/microsandbox-runtime.test.ts` under the
same Runner account and environment.
