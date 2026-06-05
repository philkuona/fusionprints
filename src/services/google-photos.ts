/**
 * Google Photos import via the Photos Picker API.
 *
 * The old Library API's broad access was retired (2025); the supported flow is:
 *   1. User grants the photospicker scope (incremental OAuth).
 *   2. We create a picker SESSION and send the user to its pickerUri.
 *   3. User selects photos in Google's own UI.
 *   4. We poll the session, list the picked mediaItems, and download each
 *      (Bearer-authenticated) to store as the user's photos.
 *
 * Tokens are short-lived and held only on the Fastify session for the duration
 * of one import (never persisted) — same model as Google sign-in.
 *
 * SETUP (Google Cloud Console, founder):
 *   - Enable "Photos Picker API".
 *   - Add scope https://www.googleapis.com/auth/photospicker.mediaitems.readonly
 *     to the OAuth consent screen (sensitive → app verification for public prod).
 *   - Register redirect URI {PUBLIC_URL}/web/api/imports/google/callback.
 */

import { env } from '@/config/env.js';

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PICKER_BASE = 'https://photospicker.googleapis.com/v1';
const PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

function redirectUri(): string {
  return `${env.PUBLIC_URL}/web/api/imports/google/callback`;
}

export function isEnabled(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function getPickerAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: PICKER_SCOPE,
    access_type: 'online',
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH_BASE}?${params.toString()}`;
}

export async function exchangeCodeForAccessToken(code: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  const token = (await res.json()) as { access_token?: string };
  if (!token.access_token) throw new Error('Google token exchange: no access_token');
  return token.access_token;
}

export interface PickerSession {
  id: string;
  pickerUri: string;
}

export async function createPickerSession(accessToken: string): Promise<PickerSession> {
  const res = await fetch(`${PICKER_BASE}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Create picker session failed: ${await res.text()}`);
  const s = (await res.json()) as { id: string; pickerUri: string };
  return { id: s.id, pickerUri: s.pickerUri };
}

/** True once the user has finished picking in the Google UI. */
export async function isSessionReady(accessToken: string, sessionId: string): Promise<boolean> {
  const res = await fetch(`${PICKER_BASE}/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Poll picker session failed: ${await res.text()}`);
  const s = (await res.json()) as { mediaItemsSet?: boolean };
  return s.mediaItemsSet === true;
}

export interface PickedMedia {
  baseUrl: string;
  mimeType: string;
  filename: string;
}

export async function listPickedMedia(accessToken: string, sessionId: string): Promise<PickedMedia[]> {
  const out: PickedMedia[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${PICKER_BASE}/mediaItems`);
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`List picked media failed: ${await res.text()}`);
    const data = (await res.json()) as {
      mediaItems?: Array<{ mediaFile?: { baseUrl?: string; mimeType?: string; filename?: string } }>;
      nextPageToken?: string;
    };
    for (const it of data.mediaItems ?? []) {
      const f = it.mediaFile;
      if (f?.baseUrl) {
        out.push({
          baseUrl: f.baseUrl,
          mimeType: f.mimeType ?? 'image/jpeg',
          filename: f.filename ?? 'google-photo.jpg',
        });
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

/** Download a picked photo at full resolution (`=d` param), Bearer-authenticated. */
export async function downloadPickedMedia(accessToken: string, baseUrl: string): Promise<Buffer> {
  const res = await fetch(`${baseUrl}=d`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Download picked media failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function deletePickerSession(accessToken: string, sessionId: string): Promise<void> {
  await fetch(`${PICKER_BASE}/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => {});
}
