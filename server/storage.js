// Object storage for user-uploaded avatars.
//
// Production: Cloudflare R2 (S3-compatible API). Required env vars:
//   R2_BUCKET             - bucket name (e.g. "aoe-avatars")
//   R2_ENDPOINT           - S3 API URL: https://<account-id>.r2.cloudflarestorage.com
//   R2_PUBLIC_BASE_URL    - where browsers fetch from (custom domain like
//                           https://avatars.aoe.example, OR the bucket's
//                           public r2.dev URL with no trailing slash)
//   R2_ACCESS_KEY_ID      - R2 API token's Access Key
//   R2_SECRET_ACCESS_KEY  - R2 API token's Secret Key
//
// If ANY of those are missing, we silently fall back to writing files to
// DATA_DIR/avatars and returning a relative "/avatars/<id>.<ext>" URL
// served by the Express static route. That keeps dev working without R2
// creds, and lets us deploy this code before the Cloudflare side is wired
// up — the first deploy that has all 5 vars set is the one that flips to
// R2 (existing player rows are unaffected; their avatar field is just an
// opaque URL the client renders in an <img>).

import fs from "node:fs";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const {
  R2_BUCKET,
  R2_ENDPOINT,
  R2_PUBLIC_BASE_URL,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  DATA_DIR = "./data",
} = process.env;

const r2Enabled = !!(
  R2_BUCKET &&
  R2_ENDPOINT &&
  R2_PUBLIC_BASE_URL &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY
);

// R2 ignores region but the AWS SDK still requires *something* — Cloudflare's
// own docs say to pass "auto". The endpoint URL is what actually routes the
// request to the right Cloudflare edge.
let s3 = null;
if (r2Enabled) {
  s3 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log(`Avatar storage: Cloudflare R2 (bucket "${R2_BUCKET}")`);
} else {
  console.log("Avatar storage: local disk fallback (R2 env not configured)");
}

// Local fallback dir — only needed when R2 is OFF (dev / single-instance with
// a writable disk). In R2 mode we never write locally, and DATA_DIR may not
// be writable at all (e.g. a multi-instance deploy with no persistent disk),
// so creating it is both pointless and dangerous: an EACCES here used to crash
// the whole server on boot. Skip it under R2, and never let it be fatal.
export const LOCAL_AVATAR_DIR = path.join(DATA_DIR, "avatars");
if (!r2Enabled) {
  try {
    fs.mkdirSync(LOCAL_AVATAR_DIR, { recursive: true });
  } catch (err) {
    console.warn(
      `Avatar local dir unavailable (${LOCAL_AVATAR_DIR}): ${err.code || err.message} — uploads will fail until R2 is configured`
    );
  }
}

const EXTS = ["png", "jpg", "webp"];
const PUBLIC_BASE = (R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");

/**
 * Store an avatar image and return its absolute public URL (with a
 * cache-bust query so the browser refetches immediately on update).
 *
 * Single file per player, keyed by `<id>.<ext>`. Uploading a new extension
 * (e.g. user switches from .jpg to .png) deletes the old extensions so the
 * bucket / disk doesn't grow with stale copies.
 */
export async function putAvatar(playerId, ext, buf, contentType) {
  if (!EXTS.includes(ext))
    throw new Error(`unsupported avatar ext: ${ext}`);

  if (r2Enabled) {
    // Clean up other extensions first. DeleteObject on a missing key is a
    // 204 on R2 (no error), so we don't need to swallow exceptions for the
    // common case — but wrap in catch in case of transient network errors,
    // since stale-copy cleanup is best-effort, not load-bearing.
    await Promise.all(
      EXTS.filter((e) => e !== ext).map((e) =>
        s3
          .send(
            new DeleteObjectCommand({
              Bucket: R2_BUCKET,
              Key: `${playerId}.${e}`,
            })
          )
          .catch(() => {})
      )
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: `${playerId}.${ext}`,
        Body: buf,
        ContentType: contentType,
        // 1h is short enough that infrequent updates by users who skip
        // a cache-buster (e.g. third-party embeds) still refresh; the
        // ?t=<now> query we append below handles our own client.
        CacheControl: "public, max-age=3600",
      })
    );
    return `${PUBLIC_BASE}/${playerId}.${ext}?t=${Date.now()}`;
  }

  // Local fallback.
  for (const e of EXTS) {
    if (e !== ext) {
      try {
        fs.unlinkSync(path.join(LOCAL_AVATAR_DIR, `${playerId}.${e}`));
      } catch {}
    }
  }
  fs.writeFileSync(path.join(LOCAL_AVATAR_DIR, `${playerId}.${ext}`), buf);
  return `/avatars/${playerId}.${ext}?t=${Date.now()}`;
}

// MIME type → extension map, exported here since both upload sites (guest
// signup, profile update) use it. Single source of truth.
export const AVATAR_MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
