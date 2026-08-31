# Workers VPC deployment and operations research

Audited on 2026-08-31 against Cloudflare's official documentation and the
official Wrangler 4.124.0 source/CLI. This note is evidence for updating
`docs/installation.md`; it is not itself an operator runbook.

## Conclusions

1. `Connectivity Directory Bind` and `Connectivity Directory Admin` are
   **account member roles**, not names in Cloudflare's custom API-token
   permission catalog. Bind is enough to attach an existing VPC Service to a
   Worker. Admin is required to create, update, or delete a VPC Service. When
   using an API token, Cloudflare says the token must belong to a user with the
   required role. [VPC Service required
   roles](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#required-roles)
2. Wrangler OAuth uses the broader `connectivity:admin` scope for both binding
   an existing VPC Service and provisioning one; its normal default grant
   currently includes `connectivity:admin`. This is a separate authorization
   system from account member roles and custom API-token permissions. [Wrangler 4.124.0
   OAuth scope source](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.124.0/packages/workers-auth/src/core/scopes.ts)
3. Tunnel administration is separate again. A custom token may use any one of
   `Cloudflare One Connectors Write`, `Cloudflare One Connector: cloudflared
Write`, or `Cloudflare Tunnel Write` for the documented create/token API
   operations. Wrangler 4.124.0 is stricter operationally: its Tunnel commands
   explicitly reject OAuth permission failures and direct the operator to an
   API token with **Account > Cloudflare Tunnel > Edit**. [Tunnel create API
   permissions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/#2-create-a-tunnel),
   [Tunnel token API
   permissions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/#get-the-tunnel-token),
   [Wrangler 4.124.0 Tunnel auth
   source](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.124.0/packages/wrangler/src/tunnel/client.ts)
4. Therefore deployment with an already-provisioned VPC Service and
   provisioning that service are two different jobs:

   | Job                                                                                      | Required capability                                                                                                                                                  |
   | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Deploy/update Workers using an existing VPC Service                                      | `Workers Scripts Write` custom-token permission (or `workers_scripts:write` OAuth scope), plus the issuing/member user having `Connectivity Directory Bind` or Admin |
   | Create/update/delete a VPC Service                                                       | The user must have `Connectivity Directory Admin`; Wrangler OAuth uses `connectivity:admin`                                                                          |
   | Create/list/delete a remotely managed Tunnel or retrieve its token with Wrangler 4.124.0 | A custom API token with Tunnel permission; do not rely on Wrangler OAuth                                                                                             |
   | Tail Worker logs                                                                         | Optional `Workers Tail Read` / `workers_tail:read`; not needed for deployment                                                                                        |

   The official API-token catalog confirms the exact token names `Workers
Scripts Write`, `Workers Tail Read`, `Cloudflare One Connectors Write`,
   `Cloudflare One Connector: cloudflared Write`, and `Cloudflare Tunnel
Write`. It does not list a `Connectivity Directory: Bind` token permission.
   [API-token permission
   catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)

## Exact CLI and lifecycle

### Tunnel

Wrangler 4.124.0 registers these experimental Tunnel commands: `create`,
`delete`, `info`, `list`, `run`, and `quick-start`. It does **not** register a
`wrangler tunnel token` command. [Wrangler command
registry](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.124.0/packages/wrangler/src/index.ts#L1750-L1770)

```sh
pnpm dlx wrangler@4.124.0 tunnel create <TUNNEL_NAME>
pnpm dlx wrangler@4.124.0 tunnel list
pnpm dlx wrangler@4.124.0 tunnel info <TUNNEL_ID>
pnpm dlx wrangler@4.124.0 tunnel delete <TUNNEL_ID>
```

For a connector on another host, obtain the remotely managed tunnel token
from the dashboard's **Add a replica** command or with the documented API:

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
  --request GET \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

There is also `wrangler tunnel run <TUNNEL_ID>`, which obtains the token and
starts `cloudflared`, and `wrangler tunnel run --token <TOKEN>`. Wrangler passes
the token to `cloudflared` through `TUNNEL_TOKEN`, rather than exposing it in
the spawned process arguments. [Wrangler Tunnel run
source](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.124.0/packages/wrangler/src/tunnel/run.ts),
[official token handling](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/#get-the-tunnel-token)

For a persistent Linux connector, Cloudflare's remote-tunnel guide uses:

```sh
sudo cloudflared service install <TUNNEL_TOKEN>
```

The connector token is a secret: anyone who obtains it can run a replica of
that tunnel. Store it in protected host secret management, do not put it in
Wrangler config or the repository, and rotate it if compromised. [Tunnel token
security and rotation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/)

### VPC Service

Create the fixed HTTP service only after the Tunnel exists:

```sh
pnpm dlx wrangler@4.124.0 vpc service create <RUNNER_SERVICE_NAME> \
  --type http \
  --tunnel-id <TUNNEL_ID> \
  --ipv4 127.0.0.1 \
  --http-port 8080

pnpm dlx wrangler@4.124.0 vpc service get <VPC_SERVICE_ID>
pnpm dlx wrangler@4.124.0 vpc service list
pnpm dlx wrangler@4.124.0 vpc service delete <VPC_SERVICE_ID>
```

These are the exact create/get/list/delete forms in Cloudflare's Wrangler VPC
reference. The create command returns the Service ID used by the Worker's
`vpc_services[].service_id` binding. [Wrangler VPC command
reference](https://developers.cloudflare.com/workers-vpc/reference/wrangler-commands/),
[VPC getting started](https://developers.cloudflare.com/workers-vpc/get-started/#3-create-a-vpc-service)

The dependency order follows Cloudflare's resource model:

```text
create Tunnel -> start connector -> create VPC Service -> deploy bound Worker
delete/unbind Worker -> delete VPC Service -> stop connector -> delete Tunnel
```

The forward direction is required because a VPC Service contains a Tunnel ID,
and a Worker binding contains a VPC Service ID. Cleanup should reverse those
references so no deployed Worker or VPC Service points at a deleted resource.
This reverse cleanup order is an operational deduction from the documented
resource fields, not a separately documented transactional guarantee. [VPC
Service configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#vpc-service-configuration),
[Worker binding configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#workers-binding-configuration)

## Connector and network requirements

- Workers VPC supports `cloudflared` 2025.7.0 or later and recommends the
  latest release. The connector must use QUIC (`auto` or `quic`), requiring
  outbound UDP port 7844. Older versions are unsupported. [Workers VPC Tunnel
  requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/#create-and-run-tunnel-cloudflared)
- The connector host must be able to reach the origin. A same-host runner may
  be registered as IPv4 `127.0.0.1`; Cloudflare's setup flow explicitly accepts
  `localhost`, IP addresses, or hostnames. Pinning IPv4 avoids a `localhost`
  resolver trying IPv6 before an IPv4-only runner. [Workers VPC setup](https://developers.cloudflare.com/workers-vpc/get-started/#3-create-a-vpc-service)
- Cloudflare's production baseline is two dedicated connector hosts per
  network location, each with at least four CPU cores and 4 GiB RAM. That is a
  high-availability recommendation, not a functional minimum for this
  single-runner deployment. [Workers VPC hardware
  requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/hardware-requirements/)
- The Tunnel uses outbound persistent connections. Workers VPC does not need
  an inbound firewall rule, public IP, public hostname, DNS route, Access
  application, or locally managed Tunnel ingress rules. Public publication is
  a separate configuration path. [Workers VPC Tunnel
  properties](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/),
  [remote Tunnel public-vs-private
  setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/#3a-publish-an-application)

## HTTP origin scheme

For this runner, Worker code must call the binding with an absolute `http://`
URL. The Tunnel encrypts traffic until it reaches the private network; `http`
then selects plaintext for the final connector-to-runner hop. `https` would
instead require the origin to serve TLS. The VPC Service's configured port is
always used, even if the fetch URL contains another port; the URL host only
sets the HTTP `Host` header (and SNI for HTTPS). [HTTP VPC
Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#http-services),
[VPC binding API](https://developers.cloudflare.com/workers-vpc/api/#vpc-service)

For the deployed shape, the correct conceptual call is therefore:

```ts
env.RUNNER.fetch('http://runner.internal/jobs/...', options);
```

`runner.internal` is not public DNS and does not control routing; the fixed
VPC Service target `127.0.0.1:8080` does.

## Beta and operational caveats

- Workers VPC is beta; features and APIs may change. It currently permits
  1,000 VPC Services per account, and normal Workers request-size, timeout, and
  subrequest limits still apply. [Workers VPC
  limits](https://developers.cloudflare.com/workers-vpc/reference/limits/)
- VPC bindings cannot be simulated wholly locally; local development must use
  a remote binding or `wrangler dev --remote`. [Workers VPC local
  test](https://developers.cloudflare.com/workers-vpc/get-started/#6-test-locally)
- Wrangler's Tunnel command group is explicitly experimental in 4.124.0 even
  though the VPC Service command group is stable. Pin and record the Wrangler
  version used for an operation instead of assuming `@latest` syntax. [Tunnel
  namespace source](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.124.0/packages/wrangler/src/tunnel/index.ts),
  [Wrangler VPC command
  reference](https://developers.cloudflare.com/workers-vpc/reference/wrangler-commands/)

## Concrete gaps in `docs/installation.md`

1. The unattended-auth table incorrectly presents `Connectivity Directory:
Bind` as a custom API-token permission. It must distinguish the account
   member roles (`Connectivity Directory Bind/Admin`), the Wrangler OAuth
   scope (`connectivity:admin` for both binding and provisioning), and custom
   token permissions.
2. The document describes only deploy-time binding. It does not state that
   provisioning the VPC Service requires Admin, while binding an existing
   service needs only Bind.
3. The Tunnel section has no reproducible create/list/info/token/delete
   procedure and does not say Wrangler OAuth cannot administer Tunnels in
   4.124.0. It should document a narrowly scoped Tunnel API token separately
   from normal Worker deployment authentication.
4. It runs `cloudflared tunnel run --token` in the foreground but omits the
   official persistent-service installation, token sensitivity, minimum
   `cloudflared` version, QUIC requirement, and outbound UDP 7844 prerequisite.
5. First installation correctly creates the VPC Service after the Tunnel and
   uses `127.0.0.1:8080`, but it should explicitly verify the connector is
   healthy before Worker deployment and explain that the core fetch scheme
   must be `http` for this plaintext origin.
6. Uninstall currently deletes Workers and D1 but never deletes the VPC
   Service or Tunnel and never stops/uninstalls the connector. It therefore
   leaves exactly the externally provisioned resources the installation
   section created. Cleanup must remove Worker references first, then the VPC
   Service, then the connector/Tunnel, with exact-ID read-back checks.
7. The no-zone-permission statement is correct for `workers.dev` ingress.
   The manual should separately state that Workers VPC itself creates no
   public Tunnel hostname or DNS record; Access/DNS permissions are unnecessary
   unless an operator deliberately adds a public hostname.
8. The beta status and the difference between stable `vpc service` commands
   and experimental `tunnel` commands are currently absent and should be an
   operations caveat, not a blocker.
