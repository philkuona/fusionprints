/**
 * QuickBooks Online integration service.
 *
 * Handles OAuth 2.0 token management, auto-refresh, and posting
 * Sales Receipts / Refund Receipts to QBO.
 *
 * Tokens are stored in qbo-tokens.json next to the app (./qbo-tokens.json).
 * In production this lands at /home/fusionprints/app/qbo-tokens.json.
 *
 * This module is intentionally free of DB imports — callers pass in the
 * order/item data they've already fetched. See the hook helpers in
 * admin-dashboard.ts for the DB-side glue.
 *
 * Non-blocking pattern: callers fire-and-forget with void + .catch so a
 * failed QBO post never fails the order itself.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';

// ── QBO API constants ──────────────────────────────────────────────────────

const QBO_AUTH_BASE   = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL   = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_API_BASE    = 'https://quickbooks.api.intuit.com/v3/company';
const QBO_SCOPES      = 'com.intuit.quickbooks.accounting';
const TOKEN_FILE_PATH = './qbo-tokens.json';

// ── Token file ─────────────────────────────────────────────────────────────

interface QboAccounts {
  photoSalesItemId:  string;
  wallArtItemId:     string;
  deliveryItemId:    string;
  ecocashAccountId:  string;
  stripeAccountId:   string;
  cashAccountId:     string;
  defaultCustomerId: string;
}

interface QboTokens {
  accessToken:              string;
  refreshToken:             string;
  realmId:                  string;
  accessTokenExpiresAt:     string; // ISO
  refreshTokenExpiresAt:    string; // ISO
  setupComplete:            boolean;
  accounts?:                QboAccounts;
}

function readTokens(): QboTokens | null {
  try {
    if (!existsSync(TOKEN_FILE_PATH)) return null;
    return JSON.parse(readFileSync(TOKEN_FILE_PATH, 'utf-8')) as QboTokens;
  } catch {
    return null;
  }
}

function writeTokens(tokens: QboTokens): void {
  writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
}

// ── Public status helpers ──────────────────────────────────────────────────

/** Returns true if QBO_CLIENT_ID is configured in env. */
export function isEnabled(): boolean {
  return Boolean(env.QBO_CLIENT_ID);
}

/** Returns true if OAuth tokens exist and refresh token hasn't expired. */
export function isConnected(): boolean {
  const tokens = readTokens();
  if (!tokens) return false;
  return new Date(tokens.refreshTokenExpiresAt) > new Date();
}

/** Returns true if connected AND setup (items/accounts found) is complete. */
export function isSetupComplete(): boolean {
  const tokens = readTokens();
  return tokens?.setupComplete === true && Boolean(tokens.accounts);
}

export function getStatus(): {
  connected:              boolean;
  setupComplete:          boolean;
  realmId?:               string;
  accessTokenExpiresAt?:  string;
  refreshTokenExpiresAt?: string;
} {
  const tokens = readTokens();
  if (!tokens) return { connected: false, setupComplete: false };
  return {
    connected:              new Date(tokens.refreshTokenExpiresAt) > new Date(),
    setupComplete:          tokens.setupComplete,
    realmId:                tokens.realmId,
    accessTokenExpiresAt:   tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt:  tokens.refreshTokenExpiresAt,
  };
}

export function disconnect(): void {
  if (existsSync(TOKEN_FILE_PATH)) {
    writeFileSync(TOKEN_FILE_PATH, JSON.stringify({ disconnected: true }, null, 2));
  }
}

// ── OAuth helpers ──────────────────────────────────────────────────────────

export function getAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id:     env.QBO_CLIENT_ID,
    scope:         QBO_SCOPES,
    redirect_uri:  `${env.PUBLIC_URL}/admin/qbo/callback`,
    response_type: 'code',
    state,
  });
  return `${QBO_AUTH_BASE}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string, realmId: string): Promise<void> {
  const credentials = Buffer.from(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`).toString('base64');

  const res = await fetch(QBO_TOKEN_URL, {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept:         'application/json',
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: `${env.PUBLIC_URL}/admin/qbo/callback`,
    }),
  });

  if (!res.ok) throw new Error(`QBO token exchange failed: ${await res.text()}`);

  const data = await res.json() as {
    access_token:                string;
    refresh_token:               string;
    expires_in:                  number;
    x_refresh_token_expires_in:  number;
  };

  writeTokens({
    accessToken:           data.access_token,
    refreshToken:          data.refresh_token,
    realmId,
    accessTokenExpiresAt:  new Date(Date.now() + data.expires_in * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + data.x_refresh_token_expires_in * 1000).toISOString(),
    setupComplete:         false,
  });
}

// ── Token refresh ──────────────────────────────────────────────────────────

async function refreshAccessToken(tokens: QboTokens): Promise<QboTokens> {
  const credentials = Buffer.from(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`).toString('base64');

  const res = await fetch(QBO_TOKEN_URL, {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept:         'application/json',
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
  });

  if (!res.ok) throw new Error(`QBO token refresh failed: ${await res.text()}`);

  const data = await res.json() as {
    access_token:                string;
    refresh_token:               string;
    expires_in:                  number;
    x_refresh_token_expires_in:  number;
  };

  const updated: QboTokens = {
    ...tokens,
    accessToken:           data.access_token,
    refreshToken:          data.refresh_token,
    accessTokenExpiresAt:  new Date(Date.now() + data.expires_in * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + data.x_refresh_token_expires_in * 1000).toISOString(),
  };
  writeTokens(updated);
  return updated;
}

async function getValidTokens(): Promise<QboTokens> {
  let tokens = readTokens();
  if (!tokens || !tokens.accessToken) throw new Error('QBO not connected');

  // Refresh if access token expires within 5 minutes
  if (new Date(tokens.accessTokenExpiresAt) < new Date(Date.now() + 5 * 60 * 1000)) {
    tokens = await refreshAccessToken(tokens);
  }
  return tokens;
}

// ── Core API request ───────────────────────────────────────────────────────

async function qboRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const tokens = await getValidTokens();
  const url = `${QBO_API_BASE}/${tokens.realmId}/${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization:  `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw new Error(`QBO API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Setup — find/create accounts and items ─────────────────────────────────

async function findAccountId(name: string): Promise<string | null> {
  const q = encodeURIComponent(`SELECT * FROM Account WHERE Name = '${name}' MAXRESULTS 1`);
  const res = await qboRequest('GET', `query?query=${q}`) as {
    QueryResponse: { Account?: Array<{ Id: string }> };
  };
  return res.QueryResponse?.Account?.[0]?.Id ?? null;
}

async function findOrCreateItem(
  name: string,
  incomeAccountId: string,
  description: string,
): Promise<string> {
  const q = encodeURIComponent(`SELECT * FROM Item WHERE Name = '${name}' MAXRESULTS 1`);
  const res = await qboRequest('GET', `query?query=${q}`) as {
    QueryResponse: { Item?: Array<{ Id: string }> };
  };
  if (res.QueryResponse?.Item?.length) return res.QueryResponse.Item[0].Id;

  const created = await qboRequest('POST', 'item', {
    Name:            name,
    Description:     description,
    Active:          true,
    Type:            'Service',
    IncomeAccountRef: { value: incomeAccountId },
  }) as { Item: { Id: string } };
  return created.Item.Id;
}

async function findOrCreateCustomer(displayName: string): Promise<string> {
  const q = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${displayName}' MAXRESULTS 1`);
  const res = await qboRequest('GET', `query?query=${q}`) as {
    QueryResponse: { Customer?: Array<{ Id: string }> };
  };
  if (res.QueryResponse?.Customer?.length) return res.QueryResponse.Customer[0].Id;

  const created = await qboRequest('POST', 'customer', {
    DisplayName: displayName,
  }) as { Customer: { Id: string } };
  return created.Customer.Id;
}

/**
 * Run once after OAuth connect.
 * Finds the Chart of Accounts entries, creates QBO Service items for each
 * income category, and creates a generic "FusionPrints Customer" in QBO.
 * Results are saved to the token file so subsequent calls are instant.
 */
export async function runSetup(): Promise<void> {
  logger.info('QBO setup: locating accounts...');

  const photoSalesAccountId = await findAccountId('Photo Print Sales');
  const wallArtAccountId    = await findAccountId('Wall Art Sales');
  const deliveryAccountId   = await findAccountId('Delivery Fee Income');

  if (!photoSalesAccountId || !wallArtAccountId || !deliveryAccountId) {
    throw new Error(
      'QBO setup: one or more income accounts not found. ' +
      'Expected: "Photo Print Sales", "Wall Art Sales", "Delivery Fee Income".',
    );
  }

  const ecocashAccountId = await findAccountId('EcoCash Business');
  const stripeAccountId  = await findAccountId('Stripe');
  const cashAccountId    = await findAccountId('Cash on Hand');

  if (!ecocashAccountId || !cashAccountId) {
    throw new Error(
      'QBO setup: payment accounts not found. ' +
      'Expected: "EcoCash Business", "Cash on Hand".',
    );
  }

  logger.info('QBO setup: creating service items...');
  const photoSalesItemId = await findOrCreateItem('Photo Print',      photoSalesAccountId, 'Photo print');
  const wallArtItemId    = await findOrCreateItem('Wall Art Print',   wallArtAccountId,    'Large format wall art print');
  const deliveryItemId   = await findOrCreateItem('Delivery',         deliveryAccountId,   'Delivery fee');

  logger.info('QBO setup: creating default customer...');
  const defaultCustomerId = await findOrCreateCustomer('FusionPrints Customer');

  const tokens = readTokens()!;
  tokens.setupComplete = true;
  tokens.accounts = {
    photoSalesItemId,
    wallArtItemId,
    deliveryItemId,
    ecocashAccountId,
    stripeAccountId:  stripeAccountId ?? cashAccountId, // fallback if Stripe not yet in COA
    cashAccountId,
    defaultCustomerId,
  };
  writeTokens(tokens);
  logger.info('QBO setup complete.');
}

// ── Sales Receipt & Refund Receipt ─────────────────────────────────────────

export interface OrderForQbo {
  orderNumber:    string;
  subtotalUsd:    string;
  deliveryFeeUsd: string;
  totalUsd:       string;
  fulfilledAt:    Date | null;
  createdAt:      Date;
}

export interface OrderItemForQbo {
  sizeCode:      string;
  quantity:      number;
  unitPriceUsd:  string;
  lineTotalUsd:  string;
  productType:   string; // 'photo_print' | 'poster'
}

function depositAccountId(paymentMethod: string | null, accounts: QboAccounts): string {
  if (paymentMethod === 'ecocash')              return accounts.ecocashAccountId;
  if (paymentMethod === 'stripe' || paymentMethod === 'card') return accounts.stripeAccountId;
  return accounts.cashAccountId;
}

function itemId(productType: string, accounts: QboAccounts): string {
  return productType === 'poster' ? accounts.wallArtItemId : accounts.photoSalesItemId;
}

function buildLines(items: OrderItemForQbo[], accounts: QboAccounts) {
  return items.map(item => ({
    Amount:     parseFloat(item.lineTotalUsd),
    DetailType: 'SalesItemLineDetail',
    Description: `${item.quantity} x ${item.sizeCode}`,
    SalesItemLineDetail: {
      ItemRef:  { value: itemId(item.productType, accounts) },
      Qty:      item.quantity,
      UnitPrice: parseFloat(item.unitPriceUsd),
    },
  }));
}

/**
 * Post a Sales Receipt to QBO when an order is fulfilled.
 * Non-blocking — caller should fire-and-forget with void + .catch.
 */
export async function createSalesReceipt(
  order: OrderForQbo,
  items: OrderItemForQbo[],
  paymentMethod: string | null,
): Promise<string> {
  const tokens = await getValidTokens();
  if (!tokens.accounts) throw new Error('QBO setup not complete — run setup first');

  const lines = buildLines(items, tokens.accounts);

  const deliveryFee = parseFloat(order.deliveryFeeUsd);
  if (deliveryFee > 0) {
    lines.push({
      Amount:     deliveryFee,
      DetailType: 'SalesItemLineDetail',
      Description: 'Delivery fee',
      SalesItemLineDetail: {
        ItemRef:  { value: tokens.accounts.deliveryItemId },
        Qty:      1,
        UnitPrice: deliveryFee,
      },
    });
  }

  const receipt = {
    DocNumber:            order.orderNumber,
    TxnDate:              (order.fulfilledAt ?? order.createdAt).toISOString().slice(0, 10),
    CustomerRef:          { value: tokens.accounts.defaultCustomerId },
    DepositToAccountRef:  { value: depositAccountId(paymentMethod, tokens.accounts) },
    Line:                 lines,
    PrivateNote:          `FusionPrints ${order.orderNumber} | ${paymentMethod ?? 'cash'}`,
  };

  const res = await qboRequest('POST', 'salesreceipt', receipt) as {
    SalesReceipt: { Id: string };
  };
  logger.info({ orderNumber: order.orderNumber, qboId: res.SalesReceipt.Id }, 'QBO Sales Receipt created');
  return res.SalesReceipt.Id;
}

/**
 * Post a Refund Receipt to QBO when a paid order is cancelled.
 * Non-blocking — caller should fire-and-forget with void + .catch.
 */
export async function createRefundReceipt(
  order: OrderForQbo,
  items: OrderItemForQbo[],
  paymentMethod: string | null,
): Promise<string> {
  const tokens = await getValidTokens();
  if (!tokens.accounts) throw new Error('QBO setup not complete — run setup first');

  const lines = buildLines(items, tokens.accounts).map(l => ({
    ...l,
    Description: l.Description + ' (refund)',
  }));

  const deliveryFee = parseFloat(order.deliveryFeeUsd);
  if (deliveryFee > 0) {
    lines.push({
      Amount:     deliveryFee,
      DetailType: 'SalesItemLineDetail',
      Description: 'Delivery fee (refund)',
      SalesItemLineDetail: {
        ItemRef:  { value: tokens.accounts.deliveryItemId },
        Qty:      1,
        UnitPrice: deliveryFee,
      },
    });
  }

  const refund = {
    DocNumber:           `REF-${order.orderNumber}`,
    TxnDate:             new Date().toISOString().slice(0, 10),
    CustomerRef:         { value: tokens.accounts.defaultCustomerId },
    DepositToAccountRef: { value: depositAccountId(paymentMethod, tokens.accounts) },
    Line:                lines,
    PrivateNote:         `Refund — FusionPrints ${order.orderNumber}`,
  };

  const res = await qboRequest('POST', 'refundreceipt', refund) as {
    RefundReceipt: { Id: string };
  };
  logger.info({ orderNumber: order.orderNumber, qboId: res.RefundReceipt.Id }, 'QBO Refund Receipt created');
  return res.RefundReceipt.Id;
}
