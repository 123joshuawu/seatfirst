import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * S3 backing store for provider-run diagnostic captures (migration 026).
 *
 * Only the small fields (url, headers) live in Postgres; the body and
 * screenshot bytes live here, referenced by key
 * (`<outcome_kind>/<run_id>/<capture_id>-body`, screenshots same with a
 * `-screenshot` suffix). The bucket name is read from
 * `DIAGNOSTIC_CAPTURE_BUCKET_NAME` at call time, never captured at import —
 * the fetch worker sets it from its environment alongside `DATABASE_URL`, and
 * reading it late keeps test/process setup order irrelevant.
 *
 * Credentials and region come from the SDK's default chain (the long-lived IAM
 * user from `infra/src/backup-stack.ts` via standard `AWS_*` env vars), the
 * same posture as the WAL-backup access: no credential plumbing in this
 * package. Errors propagate unwrapped — the actor caller try/catches and never
 * fails a run on a capture error.
 */

let client: S3Client | undefined;

function s3(): S3Client {
  client ??= new S3Client({});
  return client;
}

/** Resolves the capture bucket or throws a fail-loud error naming the env var. */
export function diagnosticBucketName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env["DIAGNOSTIC_CAPTURE_BUCKET_NAME"];
  if (name === undefined || name === "") {
    throw new Error(
      "DIAGNOSTIC_CAPTURE_BUCKET_NAME is required — the fetch worker's environment must name the diagnostic-capture S3 bucket",
    );
  }
  return name;
}

/** Uploads one capture blob (body or screenshot) under `key`. Overwrites. */
export async function uploadDiagnosticBlob(
  key: string,
  body: Buffer | string,
  contentType: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: diagnosticBucketName(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Deletes one capture blob. S3 deletes are idempotent (no error for a missing
 * key), so a retry after a half-finished sweep is a no-op, never a failure.
 */
export async function deleteDiagnosticBlob(key: string): Promise<void> {
  await s3().send(
    new DeleteObjectCommand({
      Bucket: diagnosticBucketName(),
      Key: key,
    }),
  );
}
