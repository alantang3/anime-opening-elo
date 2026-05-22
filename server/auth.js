// Google sign-in + our own session tokens.
//
// Flow: the browser gets a Google ID token (signed JWT) from Google Identity
// Services and POSTs it to /api/auth/google. We verify it against Google's
// keys (audience must be our client id), upsert the account by the stable
// Google `sub`, then hand back OUR session JWT. The socket connection
// authenticates with that session token — no guests.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";

import { DATA_DIR, getOrCreateGooglePlayer } from "./db.js";

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_TTL = "30d";

// Stable session secret: env first, else a random key persisted next to the
// DB so issued tokens survive restarts/redeploys without manual config.
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, "session-secret");
  try {
    return fs.readFileSync(f, "utf8").trim();
  } catch {
    const s = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}
const SESSION_SECRET = loadSessionSecret();

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Verifier is injectable so the auth flow can be tested without real Google
// tokens. Default verifies the ID token signature + audience against Google.
let verifyGoogleIdToken = async (idToken) => {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload(); // { sub, email, name, picture, ... }
};
export function __setGoogleVerifierForTests(fn) {
  verifyGoogleIdToken = fn;
}

export function issueSession(player) {
  return jwt.sign({ sub: player.id }, SESSION_SECRET, {
    expiresIn: SESSION_TTL,
  });
}

export function verifySession(token) {
  try {
    return jwt.verify(token, SESSION_SECRET); // { sub: playerId, iat, exp }
  } catch {
    return null;
  }
}

async function finishLogin(profile) {
  if (!profile?.sub) throw new Error("invalid Google profile");
  const player = await getOrCreateGooglePlayer({
    sub: profile.sub,
    name: profile.name,
    email: profile.email,
    picture: profile.picture,
  });
  return { token: issueSession(player), player };
}

// Verify a Google ID token (GIS credential flow) → { token, player }.
export async function loginWithGoogle(idToken) {
  if (!idToken) throw new Error("missing Google credential");
  return await finishLogin(await verifyGoogleIdToken(idToken));
}

// Verify a Google OAuth access token (token flow, used by our own custom
// sign-in button). We confirm the token was minted for THIS client id
// (tokeninfo → aud), then read the profile from userinfo.
let resolveAccessToken = async (accessToken) => {
  const ti = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?access_token=" +
      encodeURIComponent(accessToken)
  );
  if (!ti.ok) throw new Error("invalid access token");
  const info = await ti.json();
  if (info.aud !== GOOGLE_CLIENT_ID && info.azp !== GOOGLE_CLIENT_ID)
    throw new Error("token not for this app");

  const ui = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!ui.ok) throw new Error("userinfo failed");
  const p = await ui.json();
  return {
    sub: p.sub || info.sub,
    email: p.email || info.email,
    name: p.name,
    picture: p.picture,
  };
};
export function __setAccessTokenResolverForTests(fn) {
  resolveAccessToken = fn;
}

export async function loginWithGoogleAccessToken(accessToken) {
  if (!accessToken) throw new Error("missing access token");
  return await finishLogin(await resolveAccessToken(accessToken));
}
