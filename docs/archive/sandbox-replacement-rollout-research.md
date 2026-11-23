# Sandbox alternatives for the review Runner

Research update, 2026-11-22.

## Why replace Docker sbx?

A review completed checkout, then failed to set its sandbox secret after Docker authentication expired. Runner kept polling, but could only release the next review of the same PR once it could verify cleanup. A replacement should be able to create, inspect and remove job resources without an interactive vendor login. Recovery after a runtime outage still requires proof that the job released its resources. [Cleanup recovery procedure](../operations.md#recover-failed-cleanup) · [Runtime outage recovery issue](https://github.com/ariga39/compte-rendu/issues/313)

## Comparing the options

**OpenSandbox 1.2.1** has an existing Runner adapter. A native probe checked out a public repository, used a GitHub read token through Vault and completed a review through Core and D1 using a fixture model and intercepted publication. It worked with an empty Docker client configuration. The tested backend uses Docker Engine and shares the host kernel. Its egress policy needed an explicit port restriction. [Native evidence](opensandbox-native-probe.md) · [Adapter requirements](../opensandbox.md)

At the [Runner revision used for comparison](https://github.com/ariga39/compte-rendu/blob/82af699/apps/runner/src/runner.ts), two gaps affected OpenSandbox. The adapter used the initial GitHub token until its safe expiry, while the SDK provided a Vault update operation. A rotation test should show a subsequent GitHub request using the new token while model access continues. Cleanup recovery also needed to verify the sandbox and its associated resources after a lost delete acknowledgement. [Vault update semantics](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/credential-vault.md) · [Recovery PR](https://github.com/ariga39/compte-rendu/pull/235)

**nono 0.82.0** uses kernel isolation and a credential proxy. The follow-up tested a remote HTTPS relay, token rotation and cancellation. The results below identify the remaining port-policy gap. [Release](https://github.com/nolabs-ai/nono/releases/tag/v0.82.0)

**Gondolin** supplies microVMs and host-side HTTP credential substitution. Its image builder targets Alpine, and its network mediation supports HTTP/1.x. Reusing the review tools would require adapting the image and verifying streamed requests. [Upstream limitations](https://github.com/earendil-works/gondolin/blob/ca98da589edd0cd1c79333c0a2229660bb43d37b/docs/limitations.md)

## Which embedded runtime to try first

| Local microVM       | What makes it a fit                                                                                                                                                                  | What changes the decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| microsandbox 0.7.16 | Local SDK/CLI, OCI images, host and port rules, host-side TLS credential substitution. Interrupted creation has a documented retry path, with the record removed after file cleanup. | Upstream still labels it beta. Raw secret values passed via the SDK can persist in host configuration. Verify short-lived credential rotation, removal and restart reconciliation before considering real PRs. [Release](https://github.com/superradcompany/microsandbox/releases/tag/v0.7.16) · [Lifecycle](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/sandboxes/lifecycle.mdx) · [Secrets](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/security/secrets.mdx) |
| BoxLite 0.14.1      | Local KVM and OCI images, no vendor lifecycle login, host-side header substitution. Documented inventory and per-box cleanup after a hard kill.                                      | The local hostname allowlist forwards the requested port on an allowed host. Preserving the existing 80/443 restriction adds another control. A killed process can leave a box and its disk behind. [Dialer](https://github.com/boxlite-ai/boxlite/blob/v0.14.1/src/deps/libgvproxy-sys/gvproxy-bridge/egress_dialer.go#L84-L104) · [Operations](https://github.com/boxlite-ai/documentation/blob/4cb040147138c90cbfc051a45b581c237f1d7576/guides/at-scale.mdx#L508-L531)                                   |

## Native follow-up on November 22

OpenCode 2.0.32 and gh 2.98.0 exercised both runtimes with synthetic credentials, a simulated GitHub API and an HTTPS model fixture that returned a fixed review over SSE.

| Observation           | nono 0.82.0                                                                                                                                                                                                                                                                                                                                               | microsandbox 0.7.16                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model request         | OpenCode received the expected review text through a credential reverse proxy with a remote HTTPS upstream.                                                                                                                                                                                                                                               | OpenCode received the expected review in the existing review image. The guest used the runtime interception CA via Node's extra CA setting. Runner-side copy retrieved the JSONL and matched the expected text before removal.                       |
| Access to other ports | An unrelated host-loopback service was reachable from the supervisor and received zero direct or proxied requests from the sandbox. On the allowed relay hostname, however, the sandbox's ordinary HTTP request to a listening port 8443 received 200. Removing the two ordinary domain allow rules and keeping only credential routes gave the same 200. | With default-deny egress, gateway DNS and explicit TCP 443 rules for the model and GitHub hostnames, the supervisor got HTTP 200 on the relay's 8443 control while the guest connection failed. Credentialed HTTPS on 443 succeeded in that same VM. |
| GitHub token refresh  | A single supervised session ran gh before and after atomic replacement of a host-side test token. A trusted cmd credential source with a one-second test cache TTL returned the new value. The GitHub fixture identified generations one and two.                                                                                                         | The host rotated the GitHub secret with live modify. gh in the running VM reached the fixture with generation one and then generation two. The model credential still worked afterward.                                                              |
| Cancellation          | After the fixture observed an outstanding OpenCode request, terminating the supervised process group left zero matching OpenCode executable PIDs after one second (two before termination).                                                                                                                                                               | Forced removal during an outstanding OpenCode request terminated the attached execution, inspection reported the named sandbox absent, and the local inventory command succeeded.                                                                    |

### Selected trial output

These lines were transcribed from the trial reports. The nono test used a plain HTTP client on the relay hostname and port 8443. The microsandbox control made the same connection on the supervisor before testing inside the guest.

```text
nono 0.82.0
NONO-REMOTE-8443 0 200
CANCEL_READY True active ['1978', '1986']
CANCEL_AFTER []

microsandbox 0.7.16
HOST-PORT-8443-OK
GH-BEFORE=one
GH-AFTER=two
PORT-8443-DENIED
HOST-EVIDENCE-OK
CANCELLATION-CLEAN
```

Use **microsandbox for the next Runner adapter trial**. It preserved the port policy, used the existing OCI image, rotated the GitHub credential live, exported evidence and tore down an active job with its local tooling. For nono the open question has narrowed to enforcing the existing port boundary on forwarded HTTP traffic; replacing the model endpoint resolved the earlier host-loopback concern in the tested profile. The results cover normal teardown and explicit cancellation. Remaining acceptance work includes interrupted create/delete with a fresh Runner, parallel jobs, the final Runner/Core callback, and one canary review against a real model. [microsandbox lifecycle](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/sandboxes/lifecycle.mdx) · [Live secret updates](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/sandboxes/secrets.mdx#update-secrets)
