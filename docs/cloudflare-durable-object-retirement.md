# Cloudflare Durable Object retirement (issue #77)

This note uses Cloudflare's legacy `migrations` flow. Cloudflare says that
flow remains fully supported for existing Workers (while recommending
declarative `exports` for genuinely new Workers), and the two flows are
mutually exclusive ([Cloudflare Docs source MDX](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/durable-objects/reference/durable-object-class-migrations-legacy.mdx#L19-L23)).

## Decisive answer

For the existing Worker, retain the applied migration history and append one
new migration. With both classes removed from code and bindings, the safe
tracked legacy configuration is:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["Sandbox", "ReviewLeaseDurableObject"]
  },
  {
    "tag": "v2",
    "deleted_classes": ["Sandbox", "ReviewLeaseDurableObject"]
  }
]
```

Both names must be in `deleted_classes`: `v1` provisioned both namespaces, and
Cloudflare defines the delete array as the list of classes being deleted. The
two `durable_objects.bindings` entries must stay removed, as must the two code
exports. This is the documented delete sequence: remove bindings, remove code
references, add a uniquely tagged `deleted_classes` migration, then deploy
([legacy migration docs, “Delete migration”](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#delete-migration)).

Do not rewrite or remove `v1`. Migration tags are unique identifiers; the list
is ordered; every migration is applied once per environment; and once a Worker
has a migration tag, future deployments must include a migration tag. Thus an
existing Worker at `v1` advances to `v2`, while Wrangler does not resend `v1`
([legacy migration docs, “Migration Wrangler configuration”](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#migration-wrangler-configuration)).
Wrangler’s own deploy test shows this exact protocol: no prior script migration
tag sends all listed steps (`packages/wrangler/src/__tests__/deploy/durable-objects.test.ts`,
[lines 184–212](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/__tests__/deploy/durable-objects.test.ts#L184-L212)); a script at `v1`
sends only the `v2` step ([lines 235–269](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/__tests__/deploy/durable-objects.test.ts#L235-L269)).

The full tracked `v1` + `v2` list is the normal source-controlled migration
history for both an already-provisioned Worker and a new environment of that
same legacy-configured Worker (for example, a new staging environment). On a
first deployment Wrangler sends all listed migrations; the official Wrangler
deploy test demonstrates that a fresh script receives every migration step
([lines 184–212](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/__tests__/deploy/durable-objects.test.ts#L184-L212)). Thus a
fresh environment processes the create step and then the delete step in the
ordered history, while an existing Worker at `v1` receives only `v2`. Do not
drop `v1` merely because a particular environment has already applied it.

There is an important distinction between a valid tracked history and the
deployability of one final code bundle. Cloudflare's create procedure says the
created class must be referenced by the Worker code, while its delete procedure
requires that class and binding to be removed ([“Create migration”](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#create-migration);
[“Delete migration”](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#delete-migration)). It is therefore an
inference—not an explicit Cloudflare statement about this exact combined
`v1`+`v2` request—that a fresh deploy using only the post-retirement bundle
could fail class-export validation for the create step. The primary sources
establish the normal full history and its fresh-deploy ordering, but do not
establish that exact combined-request validation outcome. If fresh deployment
of the already-retired bundle is required, validate that behavior against the
Cloudflare API; the source-controlled migration history remains `v1` followed
by `v2`.

Deletion is permanent: Cloudflare says a delete migration removes all Durable
Objects for the class and their stored data, and advises copying needed data
first ([“Delete migration”](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#delete-migration)).
