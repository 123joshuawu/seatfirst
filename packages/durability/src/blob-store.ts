import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * S3 backing store for provider-run diagnostic captures (migration 026).
 *
 * Only the small fields (url, headers) live in Postgres; the body and
 * screenshot bytes live here, referenced by key
 * (`<outcome_kind>/<run_id>/<capture_id>-body`, screenshots same with a
 * `-screenshot` suffix).
 *
 * The capture bucket uses its own least-privilege IAM identity. It must never
 * fall through to the SDK's default credential chain, which would either use
 * the backup identity or fail because no standard `AWS_*` credentials exist in
 * the fetch worker.
 */

export interface DiagnosticCaptureStorageConfig {
  readonly bucketName: string;
  readonly region: string;
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
}

let storage: { readonly bucketName: string; readonly client: S3Client } | undefined;

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for diagnostic capture`);
  }
  return value;
}

export function diagnosticCaptureStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticCaptureStorageConfig {
  return {
    bucketName: diagnosticBucketName(env),
    region: requiredEnv(env, "AWS_REGION"),
    credentials: {
      accessKeyId: requiredEnv(env, "DIAGNOSTIC_AWS_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv(env, "DIAGNOSTIC_AWS_SECRET_ACCESS_KEY"),
    },
  };
}

function diagnosticStorage(): { readonly bucketName: string; readonly client: S3Client } {
  if (storage !== undefined) return storage;
  const config = diagnosticCaptureStorageConfig();
  storage = {
    bucketName: config.bucketName,
    client: new S3Client({ region: config.region, credentials: config.credentials }),
  };
  return storage;
}

/** Resolves the capture bucket or throws a fail-loud error naming the env var. */
export function diagnosticBucketName(env: NodeJS.ProcessEnv = process.env): string {
  return requiredEnv(env, "DIAGNOSTIC_CAPTURE_BUCKET_NAME");
}

/** Uploads one capture blob (body or screenshot) under `key`. Overwrites. */
export async function uploadDiagnosticBlob(
  key: string,
  body: Buffer | string,
  contentType: string,
): Promise<void> {
  const { bucketName, client } = diagnosticStorage();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
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
  const { bucketName, client } = diagnosticStorage();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    }),
  );
}
