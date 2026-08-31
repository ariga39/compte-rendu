# Workers VPC Service HTTP scheme

## Conclusion

For a plaintext HTTP runner listening at `127.0.0.1:8080`, with the VPC
Service configured using `http_port: 8080`, the Worker binding request must
use an `http://` absolute URL:

```ts
await env.RUNNER.fetch('http://127.0.0.1:8080/path', init);
```

The Tunnel already encrypts traffic until it reaches the private network. The
URL scheme instead selects the final Tunnel-to-origin protocol: `http` makes a
plaintext connection, while `https` makes a TLS connection. Configuring only
`http_port` enforces the HTTP scheme. The URL port is ignored for routing—the
VPC Service's port for the selected scheme is used—but keeping `:8080` in the
URL accurately describes the target.

Source: Cloudflare, [VPC Services — HTTP services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#http-services) and [Workers Binding API — VPC Service](https://developers.cloudflare.com/workers-vpc/api/#vpc-service).

## Comparison with Cloudflare's examples

Cloudflare's private API example is directly analogous: it creates an HTTP VPC
Service with `--http-port 8080`, then calls the binding with
`http://10.0.1.50:8080/api/data`. The general get-started example likewise
lists `http://localhost:1111` and `http://192.0.0.1:3000` for HTTP origins,
separately from an HTTPS origin example.

Sources:

- [Access a private API or website](https://developers.cloudflare.com/workers-vpc/examples/private-api/)
- [Get started — Write your Worker code](https://developers.cloudflare.com/workers-vpc/get-started/#5-write-your-worker-code)
- [Workers Binding API — `fetch()` examples](https://developers.cloudflare.com/workers-vpc/api/#examples)

## Observable failure from the wrong scheme

Cloudflare documents that a VPC binding `fetch()` throws an exception when it
cannot establish the connection; the error code is also observable in the VPC
Service's Metrics tab. Therefore `https://` against this HTTP-only service is
expected to reject/throw, not return the runner's normal HTTP response. If the
request reaches a plaintext port as TLS, Cloudflare's published error taxonomy
describes that failure as `tls_protocol_error` (TLS handshake/protocol error).

There is one documented uncertainty: Cloudflare does **not** assign a specific
public error code to the distinct case “the requested scheme has no configured
port.” A service configured with only `http_port` may reject the HTTPS scheme
before attempting TLS, so `tls_protocol_error` must not be asserted without the
actual thrown exception or VPC Metrics evidence. The guaranteed observable is
that `fetch()` throws; the exact code must be captured at runtime.

Source: Cloudflare, [Troubleshoot and debug — Connection error codes](https://developers.cloudflare.com/workers-vpc/reference/troubleshooting/#connection-error-codes).

The only case where `https://` is correct for port 8080 is when the runner
actually serves TLS and the VPC Service configures `https_port: 8080`.
