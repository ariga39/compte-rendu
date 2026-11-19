import { Effect, Schema } from 'effect';
import {
  ReviewConfiguration,
  ReviewModelSelection,
  readBoundedRequestBody,
} from '@compte-rendu/contracts';
import type { D1DatabaseLike } from './review-state-store';

interface ConfigurationRow {
  readonly revision: number;
  readonly selection: string | null;
}

const response = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

export const handleReviewConfiguration = (
  request: Request,
  database: D1DatabaseLike,
  operatorToken: string | undefined,
): Promise<Response> =>
  !operatorToken?.trim() || request.headers.get('authorization') !== `Bearer ${operatorToken}`
    ? Promise.resolve(response({ error: 'unauthorized' }, 401))
    : applyReviewConfiguration(request, database);

export const applyReviewConfiguration = (
  request: Request,
  database: D1DatabaseLike,
  availableRoutes?: readonly string[],
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (request.method === 'GET') {
        const row = yield* Effect.tryPromise(() =>
          database
            .prepare('SELECT revision, selection FROM review_configuration WHERE id = 1')
            .first<ConfigurationRow>(),
        );
        if (row === null) return response({ error: 'configuration unavailable' }, 503);
        const configuration = yield* Schema.decodeUnknownEffect(ReviewConfiguration, {
          onExcessProperty: 'error',
        })({
          revision: row.revision,
          selection:
            row.selection === null
              ? null
              : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewModelSelection), {
                  onExcessProperty: 'error',
                })(row.selection),
        });
        return response(configuration);
      }
      if (request.method !== 'PUT') return response({ error: 'method not allowed' }, 405);
      const body = yield* Effect.tryPromise(() => readBoundedRequestBody(request, 16 * 1024));
      if (body.kind === 'too-large') return response({ error: 'configuration too large' }, 413);
      const candidate = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ReviewConfiguration),
        {
          onExcessProperty: 'error',
        },
      )(body.text).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (candidate === undefined) return response({ error: 'invalid configuration' }, 400);
      const selected = candidate.selection;
      if (
        availableRoutes &&
        selected &&
        ![...selected.reviewers, selected.synthesis].every((route) =>
          availableRoutes.includes(route),
        )
      )
        return response({ error: 'model route unavailable' }, 400);
      const row = yield* Effect.tryPromise(() =>
        database
          .prepare(
            `UPDATE review_configuration SET revision = revision + 1, selection = ?
         WHERE id = 1 AND revision = ? RETURNING revision, selection`,
          )
          .bind(
            candidate.selection === null ? null : JSON.stringify(candidate.selection),
            candidate.revision,
          )
          .first<ConfigurationRow>(),
      );
      if (row === null)
        return response({ error: 'configuration changed; reload before saving' }, 409);
      return response({ revision: row.revision, selection: candidate.selection });
    }).pipe(
      Effect.catch(() => Effect.succeed(response({ error: 'configuration unavailable' }, 503))),
    ),
  );
