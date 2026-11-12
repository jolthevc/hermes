import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "./db/client.js";
import { artifacts } from "./db/schema.js";
import { env, requireEnv } from "./env.js";

// S3-compatible artifact store: Cloudflare R2 in production, MinIO locally.
// GPU workers never get storage credentials; they receive short-lived presigned URLs.

let client: S3Client | undefined;
function s3() {
  client ??= new S3Client({
    endpoint: requireEnv("S3_ENDPOINT"),
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: requireEnv("S3_ACCESS_KEY_ID"), secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY") },
  });
  return client;
}

export async function putArtifact(o: {
  key: string;
  body: Buffer;
  contentType: string;
  kind: string;
  showId?: string;
  sketchId?: string;
  parentIds?: string[];
  meta?: Record<string, unknown>;
}) {
  await s3().send(
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: o.key, Body: o.body, ContentType: o.contentType }),
  );
  const [row] = await db
    .insert(artifacts)
    .values({
      kind: o.kind,
      storageKey: o.key,
      contentType: o.contentType,
      bytes: o.body.length,
      sha256: createHash("sha256").update(o.body).digest("hex"),
      showId: o.showId,
      sketchId: o.sketchId,
      parentIds: o.parentIds ?? [],
      meta: o.meta ?? {},
    })
    .returning();
  return row!;
}

export function presignGet(key: string, seconds = 3600) {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: seconds });
}

export function presignPut(key: string, contentType: string, seconds = 3600) {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }), {
    expiresIn: seconds,
  });
}

export const artifactKey = (showId: string, sketchId: string, name: string) =>
  `shows/${showId}/sketches/${sketchId}/${name}`;
