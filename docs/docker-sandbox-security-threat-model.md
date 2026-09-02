# Docker Sandbox threat model for the PR-review runner

Research date: 2026-08-31. Sources are Docker's current Sandboxes documentation,
OpenCode's official documentation source at commit
[`10765ff`](https://github.com/anomalyco/opencode/tree/10765ff2a9da8c3b88e4de873aa383a49c318912),
and this runner's source. Docker's statements below are documented product
properties, not a claim that a hypervisor can never have a vulnerability.

## Bottom line

The review agent is not merely in a Docker container. Docker documents each
Sandbox as a microVM with its own kernel and Docker daemon. The VM cannot see
host processes, the host Docker daemon, or host files except explicit mounts;
all outbound TCP crosses a host proxy that enforces destination policy
([security model](https://docs.docker.com/ai/sandboxes/security/),
[isolation layers](https://docs.docker.com/ai/sandboxes/security/isolation/)).

That changes the sensible boundary. Read-only inspection and full Git history
are not meaningful host-compromise risks. They should be available to the
reviewer. The controls worth keeping hard are the actual VM exits: host mounts,
shared host integrations, credentials, and network reachability.

The product decision is therefore to run OpenCode fully autonomously inside
the microVM: no tool or command allowlist, no approval prompts, and builds,
tests, package installation, repository programs, edits, and private-VM Docker
use are all available at the agent's discretion. OpenCode permissions are not a
security boundary in this mode. The outer Sandbox boundaries below define the
maximum consequence of a prompt injection or malicious repository.

## Assets and attacker

Assume a PR author can place adversarial text and code anywhere in the checkout
and PR discussion, and that this can prompt-inject the model. Protect:

- the NUC, its filesystem, Docker daemon, SSH identities, and home network;
- GitHub and model credentials;
- review integrity (the result must describe the immutable PR evidence);
- bounded model spend, CPU, memory, disk, and wall time.

Repository confidentiality is not an asset for the current public-repository
deployment: the product intentionally sends the repository and PR context to
`opencode.ai`.

## Practical attack paths

| Attack path                                                             | Real consequence in this runner                                                                                                                                                                                                                                                                                                                                                                                                                               | Treatment                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Docker Sandboxes/hypervisor escape                                    | Potential host compromise, but it requires a vulnerability below the agent-tool layer. Denying `git log` does not mitigate it.                                                                                                                                                                                                                                                                                                                                | Keep `sbx` and the host patched; do not use hypothetical VM escape as a reason to cripple static review.                                                                                                                                                                                                                   |
| A writable or sensitive host mount                                      | This is a documented boundary crossing. Direct mode can alter host source, hooks, CI and IDE config. Clone mode instead exposes the source read-only and works in a private VM clone ([workspace isolation](https://docs.docker.com/ai/sandboxes/security/isolation/#workspace-isolation)).                                                                                                                                                                   | Keep `--clone`; mount only the generated per-job checkout/context/config, make evidence artifacts read-only, and never mount home, Docker sockets, or credential directories. The current writable config mount is a disposable per-job temp directory, so compromise affects review integrity, not persistent host state. |
| Shared skills, MCP, or SSH-agent forwarding                             | Shared skills are a writable host store across sandboxes; local stdio MCP servers run on the host; when `SSH_AUTH_SOCK` is present Docker forwards signing capability into the VM. These are real exceptions to VM isolation ([security model](https://docs.docker.com/ai/sandboxes/security/#what-is-not-isolated-by-default), [SSH agent](https://docs.docker.com/ai/sandboxes/configuration/credentials/#ssh-agent)).                                      | Keep `--no-share-skills`, no MCP server, and ensure the runner/daemon has no SSH agent to forward.                                                                                                                                                                                                                         |
| Arbitrary outbound network                                              | Docker's host proxy makes connections using host routing. A wildcard allow can therefore expose LAN/internal services reachable from the NUC, not just the public Internet ([architecture](https://docs.docker.com/ai/sandboxes/architecture/#networking)).                                                                                                                                                                                                   | Keep deny-by-default and allow only `opencode.ai:443` and `api.github.com:443`. This is a high-value security boundary.                                                                                                                                                                                                    |
| Model-secret misuse                                                     | A custom secret puts only a generated placeholder in the VM. However, **any sandbox process** can put that placeholder in a request to the configured host and Docker replaces it with the real value ([custom secrets](https://docs.docker.com/ai/sandboxes/configuration/credentials/#custom-secrets)). Arbitrary code therefore cannot recover the key, but can make authenticated `opencode.ai` requests, spend quota, and send any readable input there. | Keep the secret sandbox-scoped, one host, a job deadline/resource limits, and immediate cleanup. This capability is inherent: OpenCode itself needs it, so shell micromanagement cannot eliminate it. Custom secrets are documented as experimental.                                                                       |
| Execute repository scripts, builds, tests, hooks, or package installers | Untrusted code receives sudo and a private Docker daemon inside the VM ([default posture](https://docs.docker.com/ai/sandboxes/security/defaults/#agent-capabilities-inside-the-sandbox)). It can corrupt the private working copy, falsify later evidence, exhaust resources, and use the model or built-in GitHub placeholder against its allowed host. With the outer boundaries above it still cannot normally alter the NUC or reach arbitrary services. | Allowed by the fully autonomous-agent decision. Bound the consequence outside OpenCode with immutable input revisions, CPU/memory/disk/wall-time limits, narrow credentials/network, output validation, and forced VM destruction.                                                                                         |
| Edit the private clone                                                  | Clone mode prevents writes reaching the host, but edits can make the agent inspect its own modified state rather than the submitted PR.                                                                                                                                                                                                                                                                                                                       | Allowed. Preserve the immutable base/head objects and read-only PR-context evidence outside the writable clone, and validate/publicize the result against those exact revisions. Treat a review that cannot be tied back to that evidence as an integrity failure, not as a host-security incident.                        |
| Read files and inspect Git history                                      | `read`, `grep`, `glob`, and Git history commands inspect data already supplied to the model. They neither add a host path nor an egress destination.                                                                                                                                                                                                                                                                                                          | Unrestricted inside the VM. Full commit history and normal Git/shell analysis are expected review inputs.                                                                                                                                                                                                                  |

## Live GitHub read access

The product lets the reviewer fetch live repository/PR context without giving it
the Product App's write authority. Docker Sandboxes 0.39 provides this through
the sandbox-scoped built-in `github` service.

When minting an installation access token, GitHub accepts `repositories` or
`repository_ids` to restrict that token to named repositories, and a
`permissions` object to request a subset of the App's installed permissions.
The token cannot gain a repository or permission the installation/App does not
already have. Omitting both restrictions is the dangerous default: the token
then receives every installed repository and all granted App permissions
([GitHub authentication guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation#using-an-installation-access-token),
[create-token endpoint](https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-an-installation-access-token-for-an-app)).

For one review run, the mint request can therefore specify exactly the target
repository and only:

```json
{
  "repository_ids": [123456789],
  "permissions": {
    "contents": "read",
    "issues": "read",
    "pull_requests": "read",
    "metadata": "read"
  }
}
```

GitHub documents all four as valid token permission fields. This downgrade is
effective even though the installed App has write access to Issues and Pull
requests. The response reports the effective repositories, permissions and
expiry, so the caller should validate those fields before releasing the token
to the runner. GitHub does **not** offer a PR-number restriction here: the
capability is one-repository read-only, including all issues and PRs that those
permissions expose, rather than one-PR read-only.

An installation token expires one hour after creation. It can also be
invalidated immediately by authenticating with it to
`DELETE /installation/token`; after revocation it cannot be used again
([expiry](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation#using-an-installation-access-token),
[revocation endpoint](https://docs.github.com/en/rest/apps/installations?apiVersion=2022-11-28#revoke-an-installation-access-token)).
Removing the built-in `github` service only removes the proxy mapping; it is not
a GitHub revocation. Runner terminal cleanup removes the Sandbox-local proxy
access and host-side token file. The current implementation relies on GitHub's
one-hour expiry; explicit token revocation is unimplemented optional hardening,
not an active Core path.

For each run, the Runner writes the validated one-repository installation token
to a temporary host-side file and registers the built-in service with a host
command that reads it:

```console
sbx secret set github \
  --sandbox SANDBOX_NAME \
  --command 'cat TOKEN_FILE' \
  --refresh on-demand
```

Docker exposes only a proxy placeholder in the VM and provides `GH_TOKEN` to
the sandbox-scoped service for matching GitHub requests. Network egress remains
limited to `api.github.com:443`; REST and GraphQL (`/graphql`) both use that
host, while the existing checkout already supplies Git history. Any sandbox
process can use the proxy placeholder at that host; the meaningful maximum
consequence is reading the target repository's Contents/Issues/Pull
requests/Metadata and consuming its API quota. It cannot comment, review,
merge, push, or access another private repository with that token.

`--refresh on-demand` reruns the host command for each credential use. With
`cat TOKEN_FILE`, that rereads the file but does not mint or renew the
installation token. Terminal cleanup removes the Sandbox, built-in service
registration, network policy, and host-side token file. The current
implementation relies on GitHub's one-hour expiry; explicit token revocation is
unimplemented optional hardening, not an active Core path.

For the current public-repository product, live repository context is a
proportionate capability. It adds two product risks, not a NUC-compromise path:

- live comments/review state can change during a run, so results are less
  reproducible than a Core-produced snapshot tied to the accepted base/head;
- a prompt-injected agent can browse unrelated issues/PRs in the same
  repository and consume API quota.

Those risks can be bounded by retaining the exact queried/derived context with
the review evidence, the existing run deadline, one token per run, and optional
explicit-revocation hardening. A precomputed immutable snapshot remains
preferable when complete reproducibility is required; the narrow live token
remains reasonable when useful historical context cannot be predicted upfront.

## OpenCode's unrestricted inner environment

OpenCode's `bash` tool can run any shell command, while `edit` covers its file
modification tools. Granular bash rules use simple wildcard matching and the
last matching rule wins
([tools](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/web/src/content/docs/tools.mdx#L42-L98),
[permissions](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/web/src/content/docs/permissions.mdx#L54-L87)).
The chosen review mode does not configure those rules as a deny/ask boundary.
The agent may use every OpenCode tool without approval and may run arbitrary
shell commands. The security boundary is instead the microVM, exact mount list,
credential proxy, network policy, resource/deadline envelope, and terminal
destruction.

This intentionally accepts residual risk inside one disposable run:

- repository prompt injection can make the agent spend the full CPU, memory,
  disk, wall-time, model-quota, or GitHub API budget;
- repository code can alter the private clone and any other writable in-VM
  state, so the resulting review can be incomplete, misleading, or based on
  modified evidence;
- any process can exercise the model credential at `opencode.ai`, and the
  built-in GitHub service provides the single-repository read capability at
  `api.github.com`;
- a hostile workload can crash or wedge the VM and turn the run into a failed
  cleanup/retry rather than a review result.

None of those capabilities should cross to the NUC, other repositories, GitHub
write operations, or the home network while the outer controls hold. Outcome
quality must still be judged from the retained result and exact base/head
evidence; a successful command/session/cleanup is not sufficient.

## Documented facts versus assumptions to verify

Documented by Docker:

- microVM/separate-kernel isolation and a private in-VM Docker daemon;
- clone mode's host repository mount is read-only, while its VM clone is
  writable; the mount includes untracked and ignored files;
- no host filesystem access outside explicit workspaces/shared skills;
- all outbound TCP is policy-controlled, while direct external UDP/ICMP is
  blocked;
- proxy-managed credentials remain host-side, but the placeholder grants use
  of the credential at its matched host;
- `sbx rm` deletes the VM and its contents.

Runner-specific facts visible in
[`runner.ts`](../apps/runner/src/runner.ts): it uses `--clone` and
`--no-share-skills`, removes the Git remote and checkout credential before VM
creation, scopes the model custom secret to one sandbox, registers the
sandbox-scoped built-in `github` service with a host command that reads the
temporary one-repository token file, allows only `opencode.ai:443` and
`api.github.com:443`, bounds the run, and removes the Sandbox, model custom
secret, built-in `github` service, policy, and temporary source/token-file
directories afterward.

Still assumptions until checked on the deployed NUC:

- the runner and `sandboxd` environments do not contain `SSH_AUTH_SOCK`;
- no global/org policy or agent kit adds network allows beyond
  `opencode.ai:443` and `api.github.com:443` (`sbx policy ls --wide` is the
  authority);
- every new PR-context artifact is mounted read-only and contains no GitHub
  credential; the built-in `github` service exposes only its proxy placeholder,
  while its host-side one-repository token file remains outside the Sandbox;
- resource and cleanup behavior remains effective against a deliberately
  hostile fork/CPU/disk probe.

Those four checks are proportionate runtime verification. A military-style
attempt to forbid every read-only command is not.
