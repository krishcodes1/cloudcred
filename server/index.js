/**
 * ClaudeCredit Server v4.0.0
 * Backend API for Plaid + MX + AI integration
 *
 * Security improvements in v4:
 * - Firebase Auth middleware on all protected endpoints
 * - Plaid access tokens stored server-side only (never sent to client)
 * - AI proxy endpoint (Groq API key never on client)
 * - CORS restricted to app origins only
 * - Rate limiting on all endpoints
 * - Webhook signature verification
 * - Sanitized error responses
 * - Input validation on path parameters
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust first proxy (Fly.io) — needed for correct req.ip in rate limiting
app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────────────────────────

// Security headers (helmet) - must be first middleware
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow mobile app requests
    contentSecurityPolicy: false, // API-only server, no HTML
}));

// CORS: Only allow requests from our app (mobile apps send no origin, so allow that too)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0) {
            // In production, reject unknown origins when ALLOWED_ORIGINS is not set
            if (process.env.NODE_ENV === 'production') {
                return callback(new Error('CORS: Origin not allowed (no origins configured)'));
            }
            return callback(null, true); // dev mode fallback
        }
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error('CORS: Origin not allowed'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Capture raw body for webhook signature verification
app.use(express.json({
    limit: '5mb',
    verify: (req, res, buf) => {
        // Store raw body buffer for webhook signature verification
        if (req.url === '/api/plaid/webhook') {
            req.rawBody = buf;
        }
    },
}));

// Rate limiting (in-memory with size cap — use Redis for multi-instance)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 60; // 60 requests per minute
const RATE_LIMIT_MAP_MAX_SIZE = 10000; // Prevent unbounded memory growth

function rateLimit(req, res, next) {
    // Use Firebase UID if authenticated, otherwise IP
    const key = req.userId || req.ip || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

    if (now > entry.resetAt) {
        entry.count = 0;
        entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
    }

    entry.count++;
    rateLimitMap.set(key, entry);

    // Cap map size to prevent memory exhaustion under attack
    if (rateLimitMap.size > RATE_LIMIT_MAP_MAX_SIZE) {
        const oldest = rateLimitMap.keys().next().value;
        rateLimitMap.delete(oldest);
    }

    if (entry.count > RATE_LIMIT_MAX) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        res.setHeader('Retry-After', retryAfter);
        return sendError(res, 429, 'Too many requests. Please try again later.');
    }

    res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - entry.count));
    next();
}

// Clean up rate limit map every minute (was 5 min — too slow)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(key);
    }
}, 60 * 1000);

app.use(rateLimit);

// Fetch with timeout — prevents hanging on unresponsive external APIs
function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

// Request ID + logging
const { randomUUID } = require('crypto');
app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        const level = res.statusCode >= 400 ? 'ERROR' : 'INFO';
        console.log(`[${level}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms uid=${req.userId || 'anon'} rid=${req.requestId}`);
    });
    next();
});

// ─── Firebase Auth Middleware ────────────────────────────────────────────────

const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
} else {
    // Fallback: try default credentials (works on GCP/Firebase hosting)
    try {
        admin.initializeApp();
    } catch (e) {
        console.warn('[Auth] Firebase Admin SDK not configured - auth middleware will reject all requests');
        console.warn('[Auth] Set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS env var');
    }
}

/**
 * Verify Firebase ID token from Authorization header.
 * All protected endpoints must use this middleware.
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendError(res, 401, 'Missing or invalid Authorization header');
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.userId = decodedToken.uid;
        req.userEmail = decodedToken.email;
        next();
    } catch (error) {
        console.error('[Auth] Token verification failed:', error.message);
        return sendError(res, 401, 'Invalid or expired authentication token');
    }
}

/**
 * Optional auth — tries to verify token but proceeds even if it fails.
 * Used for endpoints like AI chat that should work even if auth has issues.
 * Still rate-limited by IP when unauthenticated.
 */
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const idToken = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            req.userId = decodedToken.uid;
            req.userEmail = decodedToken.email;
        } catch (error) {
            console.warn('[Auth] Optional auth failed (proceeding anyway):', error.message);
            req.userId = req.ip || 'anonymous';
        }
    } else {
        req.userId = req.ip || 'anonymous';
    }
    next();
}

// ─── Supabase Token Store ───────────────────────────────────────────────────
// Plaid access tokens are stored in Supabase for persistence across restarts.
// Table: plaid_tokens (user_id, item_id, access_token)

const supabaseDb = require('./supabase');
const aiChat = require('./ai-chat');
const syncHandlers = require('./sync');

async function storeAccessToken(userId, itemId, accessToken) {
    await supabaseDb.storeAccessToken(userId, itemId, accessToken);
}

async function getAccessToken(userId, itemId) {
    return await supabaseDb.getAccessToken(userId, itemId);
}

async function getAllItemIds(userId) {
    const tokenMap = await supabaseDb.getAllAccessTokens(userId);
    return Object.keys(tokenMap);
}

async function removeAccessToken(userId, itemId) {
    await supabaseDb.removeAccessToken(userId, itemId);
}

/**
 * Middleware: Resolve Firebase UID to Supabase user UUID.
 * Must be called after requireAuth. Sets req.supabaseUserId.
 */
async function resolveSupabaseUser(req, res, next) {
    try {
        const supabaseUserId = await supabaseDb.getOrCreateUser(
            req.userId,
            req.userEmail,
            null
        );
        if (!supabaseUserId) {
            return sendError(res, 500, 'Failed to resolve user account');
        }
        req.supabaseUserId = supabaseUserId;
        next();
    } catch (error) {
        console.error('[Supabase] User resolution failed:', error.message);
        return sendError(res, 500, 'Database error');
    }
}

/**
 * Helper: resolve access token from item_id in request body.
 * The client sends item_id, we look up the access_token from Supabase.
 */
async function resolveAccessToken(req, res) {
    const { item_id } = req.body;
    if (!item_id) {
        sendError(res, 400, 'Missing required field: item_id');
        return null;
    }
    if (!isValidId(item_id)) {
        sendError(res, 400, 'Invalid item_id format');
        return null;
    }
    // Use Supabase user UUID if available, fall back to Firebase UID
    const userId = req.supabaseUserId || req.userId;
    const accessToken = await getAccessToken(userId, item_id);
    if (!accessToken) {
        sendError(res, 404, 'No linked account found for this item. Please reconnect.');
        return null;
    }
    return accessToken;
}

// ─── MX User GUID Store (Supabase) ──────────────────────────────────────────
// Maps Firebase userId -> MX user GUID via the users table.

async function storeMxUserGuid(userId, mxUserGuid) {
    await supabaseDb.storeMXUserGuid(userId, mxUserGuid);
}

async function getMxUserGuid(userId) {
    return await supabaseDb.getMXUserGuid(userId);
}

/**
 * Helper: resolve and verify MX user_guid ownership.
 * Returns the stored GUID (ignoring whatever client sent) to prevent spoofing.
 */
async function resolveMxUserGuid(req, res) {
    const storedGuid = await getMxUserGuid(req.supabaseUserId || req.userId);
    if (!storedGuid) {
        sendError(res, 404, 'No MX account found. Please connect an account first.');
        return null;
    }
    // If client sent a guid, verify it matches what we have stored
    if (req.body.user_guid && req.body.user_guid !== storedGuid) {
        sendError(res, 403, 'Access denied: invalid user_guid.');
        return null;
    }
    return storedGuid;
}

// ─── Input Validation ───────────────────────────────────────────────────────

/** Validate that path parameters don't contain path traversal characters */
function isValidId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^[a-zA-Z0-9_\-:.]+$/.test(id);
}

// ─── Plaid Configuration ─────────────────────────────────────────────────────

const plaidConfig = new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
        headers: {
            'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
            'PLAID-SECRET': process.env.PLAID_SECRET,
        },
    },
});

const plaidClient = new PlaidApi(plaidConfig);

const WEBHOOK_URL = process.env.PLAID_WEBHOOK_URL || 'https://server-spring-river-1848.fly.dev/api/plaid/webhook';

// ─── MX Configuration ────────────────────────────────────────────────────────

const MX_API_KEY = process.env.MX_API_KEY;
const MX_CLIENT_ID = process.env.MX_CLIENT_ID;
const MX_ENV = process.env.MX_ENV || 'sandbox'; // sandbox or production
const MX_BASE_URL = MX_ENV === 'production'
    ? 'https://api.mx.com'
    : 'https://int-api.mx.com';

function getMxHeaders() {
    return {
        'Accept': 'application/vnd.mx.api.v1+json',
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${MX_CLIENT_ID}:${MX_API_KEY}`).toString('base64'),
    };
}

function isMxConfigured() {
    return !!(MX_API_KEY && MX_CLIENT_ID);
}

// ─── Helper: Structured Error Response ───────────────────────────────────────

function sendError(res, statusCode, message, details = null, errorCode = null) {
    const body = {
        error: message,
        status: statusCode,
        timestamp: new Date().toISOString(),
    };
    if (details) body.details = details;
    if (errorCode) body.error_code = errorCode;
    return res.status(statusCode).json(body);
}

// ─── Helper: snake_case ↔ camelCase ─────────────────────────────────────────
// Supabase returns snake_case, iOS expects camelCase

function snakeToCamel(str) {
    return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(str) {
    return str.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
}

// Fields that Postgres returns as strings (DECIMAL) but iOS expects as numbers
const NUMERIC_FIELDS = new Set([
    'current_balance', 'available_balance', 'credit_limit', 'minimum_payment',
    'amount', 'target_amount', 'current_amount', 'net_pay', 'gross_earnings',
    'currentBalance', 'availableBalance', 'creditLimit', 'minimumPayment',
    'targetAmount', 'currentAmount',
]);

function transformKeys(obj, fn) {
    if (Array.isArray(obj)) return obj.map(item => transformKeys(item, fn));
    if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
        return Object.fromEntries(
            Object.entries(obj).map(([key, val]) => {
                const newKey = fn(key);
                let newVal = transformKeys(val, fn);
                // Convert DECIMAL string → number for known numeric fields
                if (typeof newVal === 'string' && (NUMERIC_FIELDS.has(key) || NUMERIC_FIELDS.has(newKey))) {
                    const num = parseFloat(newVal);
                    if (!isNaN(num)) newVal = num;
                }
                return [newKey, newVal];
            })
        );
    }
    return obj;
}

function toCamelCase(obj) { return transformKeys(obj, snakeToCamel); }
function toSnakeCase(obj) { return transformKeys(obj, camelToSnake); }

// ─── Helper: Validate Required Fields ────────────────────────────────────────

function requireFields(req, res, fields) {
    const missing = fields.filter(f => req.body[f] === undefined || req.body[f] === null);
    if (missing.length > 0) {
        sendError(res, 400, `Missing required fields: ${missing.join(', ')}`);
        return false;
    }
    return true;
}

// ─── Helper: Plaid Error Handler ─────────────────────────────────────────────

function handlePlaidError(res, error, context) {
    const plaidError = error.response?.data;
    console.error(`[Plaid Error] ${context}:`, plaidError || error.message);

    if (plaidError) {
        return sendError(
            res,
            error.response.status || 500,
            plaidError.error_message || 'Plaid API error',
            plaidError.display_message || null,
            plaidError.error_code || null
        );
    }
    return sendError(res, 500, `Failed: ${context}`, error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH & STATUS
// ═══════════════════════════════════════════════════════════════════════════════

// Public health check - minimal info only (no config leakage)
app.get('/', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Detailed status - requires auth
app.get('/api/status', requireAuth, (req, res) => {
    res.json({
        status: 'ok',
        version: '4.0.0',
        environment: process.env.PLAID_ENV || 'sandbox',
        providers: {
            plaid: !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
            mx: isMxConfigured(),
        },
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: LINK TOKENS (Smart Product Selection)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Link Token with SMART product selection.
 *
 * The key insight: Plaid's Liabilities product only works with credit accounts.
 * If a user wants to connect a checking/savings account, requesting Liabilities
 * causes "NO_LIABLE_ACCOUNTS" errors. So we need separate flows:
 *
 * - account_type: "credit"     -> Products: Transactions + Liabilities
 * - account_type: "depository" -> Products: Transactions + Auth
 * - account_type: "all" (default) -> Products: Transactions only (safest)
 *   Then fetch liabilities separately after seeing what accounts were linked.
 */
app.post('/api/plaid/create-link-token', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { client_user_id, account_type, products: requestedProducts } = req.body;

        // Smart product selection based on what user wants to connect
        let products;
        let accountFilters;

        const type = (account_type || 'all').toLowerCase();

        switch (type) {
            case 'credit':
                // Credit cards only - include Liabilities for APR/due dates
                products = [Products.Transactions, Products.Liabilities];
                accountFilters = {
                    credit: { account_subtypes: ['credit card'] },
                };
                break;

            case 'depository':
                // Checking/savings only - NO Liabilities (would error)
                products = [Products.Transactions, Products.Auth];
                accountFilters = {
                    depository: { account_subtypes: ['checking', 'savings', 'money market', 'cd'] },
                };
                break;

            case 'payroll':
                // Payroll/income only - connects to ADP, Gusto, Workday, etc.
                products = [Products.PayrollIncome || 'payroll'];
                accountFilters = undefined;
                break;

            case 'investment':
                // Investment/brokerage accounts - Investments product for holdings data
                products = [Products.Investments];
                accountFilters = {
                    investment: { account_subtypes: ['brokerage', '401k', 'ira', 'roth'] },
                };
                break;

            case 'all':
            default:
                // Both types - use only Transactions (safest, works for all)
                // We'll fetch liabilities separately after link for credit accounts
                products = [Products.Transactions];
                accountFilters = {
                    credit: { account_subtypes: ['credit card'] },
                    depository: { account_subtypes: ['checking', 'savings', 'money market', 'cd'] },
                };
                break;
        }

        // Allow safe product override from client (whitelist only)
        const ALLOWED_PRODUCTS = new Set(['transactions', 'liabilities', 'auth', 'identity', 'payroll', 'investments']);
        if (requestedProducts && Array.isArray(requestedProducts)) {
            const sanitized = requestedProducts.filter(p => ALLOWED_PRODUCTS.has(p));
            if (sanitized.length > 0) products = sanitized;
        }

        const request = {
            user: { client_user_id: client_user_id || 'user-' + Date.now() },
            client_name: 'ClaudeCredit',
            products: products,
            country_codes: [CountryCode.Us],
            language: 'en',
            webhook: WEBHOOK_URL,
        };
        if (accountFilters) {
            request.account_filters = accountFilters;
        }

        console.log(`[Link Token] Creating for type="${type}", products=[${products.join(', ')}]`);

        const response = await plaidClient.linkTokenCreate(request);

        res.json({
            link_token: response.data.link_token,
            expiration: response.data.expiration,
            request_id: response.data.request_id,
            account_type: type,
        });
    } catch (error) {
        // Fallback: if products aren't supported, try with just Transactions
        if (error.response?.data?.error_code === 'PRODUCTS_NOT_SUPPORTED') {
            console.log('[Link Token] Products not supported, falling back to Transactions only...');
            try {
                const { client_user_id } = req.body;
                const fallbackResponse = await plaidClient.linkTokenCreate({
                    user: { client_user_id: client_user_id || 'user-' + Date.now() },
                    client_name: 'ClaudeCredit',
                    products: [Products.Transactions],
                    country_codes: [CountryCode.Us],
                    language: 'en',
                    webhook: WEBHOOK_URL,
                    account_filters: {
                        credit: { account_subtypes: ['credit card'] },
                        depository: { account_subtypes: ['checking', 'savings', 'money market', 'cd'] },
                    },
                });

                return res.json({
                    link_token: fallbackResponse.data.link_token,
                    expiration: fallbackResponse.data.expiration,
                    request_id: fallbackResponse.data.request_id,
                    account_type: 'all',
                    fallback: true,
                });
            } catch (fallbackError) {
                return handlePlaidError(res, fallbackError, 'create link token (fallback)');
            }
        }
        handlePlaidError(res, error, 'create link token');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: UPDATE MODE LINK TOKEN (add liabilities consent to existing items)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/create-update-link-token', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { item_id } = req.body;
        if (!item_id) {
            return res.status(400).json({ error: 'Missing item_id' });
        }

        // Get access token for this item from the database
        const accessToken = await getAccessToken(req.supabaseUserId, item_id);
        if (!accessToken) {
            return res.status(404).json({ error: 'Item not found or no access token' });
        }

        const request = {
            client_name: 'ClaudeCredit',
            language: 'en',
            country_codes: [CountryCode.Us],
            user: { client_user_id: req.supabaseUserId },
            access_token: accessToken,
            webhook: WEBHOOK_URL,
            update: {
                account_selection_enabled: false,
            },
            // Request additional consent for liabilities (due dates, APR, statement balances)
            additional_consented_products: [Products.Liabilities],
        };

        console.log(`[Link Token] Creating UPDATE MODE token for item=${item_id} to add liabilities consent`);
        const response = await plaidClient.linkTokenCreate(request);

        res.json({
            link_token: response.data.link_token,
            expiration: response.data.expiration,
            request_id: response.data.request_id,
        });
    } catch (error) {
        console.error('[Plaid] Update link token error:', error.response?.data || error.message);
        handlePlaidError(res, error, 'create update link token');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: TOKEN EXCHANGE
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/exchange-token', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!requireFields(req, res, ['public_token'])) return;

        const response = await plaidClient.itemPublicTokenExchange({
            public_token: req.body.public_token,
        });

        // Store access token SERVER-SIDE only - never send to client
        const accessToken = response.data.access_token;
        const itemId = response.data.item_id;
        await storeAccessToken(req.supabaseUserId, itemId, accessToken);

        res.json({
            item_id: itemId,
            request_id: response.data.request_id,
            // NOTE: access_token is intentionally NOT returned to client
        });
    } catch (error) {
        handlePlaidError(res, error, 'exchange token');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: ACCOUNTS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/accounts', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const response = await plaidClient.accountsGet({
            access_token: accessToken,
        });

        res.json({
            accounts: response.data.accounts,
            item: response.data.item,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'get accounts');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: BALANCE
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/balance', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const request = { access_token: accessToken };
        if (req.body.account_ids?.length > 0) {
            request.options = { account_ids: req.body.account_ids };
        }

        const response = await plaidClient.accountsBalanceGet(request);

        res.json({
            accounts: response.data.accounts,
            item: response.data.item,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'get balance');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: TRANSACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/transactions', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const { start_date, end_date, account_ids, count, offset } = req.body;

        const endDate = end_date || new Date().toISOString().split('T')[0];
        const startDate = start_date || new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const request = {
            access_token: accessToken,
            start_date: startDate,
            end_date: endDate,
            options: {
                count: count || 500,
                offset: offset || 0,
                include_personal_finance_category: true,
                include_logo_and_counterparty_beta: true,
            },
        };

        if (account_ids?.length > 0) {
            request.options.account_ids = account_ids;
        }

        const response = await plaidClient.transactionsGet(request);

        res.json({
            accounts: response.data.accounts,
            transactions: response.data.transactions,
            total_transactions: response.data.total_transactions,
            item: response.data.item,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'get transactions');
    }
});

// Transaction Sync (incremental)
app.post('/api/plaid/transactions/sync', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const request = {
            access_token: accessToken,
            options: {
                include_personal_finance_category: true,
                include_logo_and_counterparty_beta: true,
            },
        };
        if (req.body.cursor) request.cursor = req.body.cursor;
        if (req.body.count) request.count = req.body.count;

        const response = await plaidClient.transactionsSync(request);

        res.json({
            added: response.data.added,
            modified: response.data.modified,
            removed: response.data.removed,
            next_cursor: response.data.next_cursor,
            has_more: response.data.has_more,
            accounts: response.data.accounts,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'sync transactions');
    }
});

// Recurring Transactions
app.post('/api/plaid/transactions/recurring', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const request = { access_token: accessToken };
        if (req.body.account_ids?.length > 0) {
            request.account_ids = req.body.account_ids;
        }

        const response = await plaidClient.transactionsRecurringGet(request);

        res.json({
            inflow_streams: response.data.inflow_streams,
            outflow_streams: response.data.outflow_streams,
            updated_datetime: response.data.updated_datetime,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'get recurring transactions');
    }
});

// Enrich Transactions
app.post('/api/plaid/transactions/enrich', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { transactions, account_type } = req.body;
        if (!transactions || !Array.isArray(transactions)) {
            return sendError(res, 400, 'transactions array is required');
        }

        const response = await plaidClient.transactionsEnrich({
            account_type: account_type || 'credit',
            transactions,
        });

        res.json({
            enriched_transactions: response.data.enriched_transactions,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'enrich transactions');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: LIABILITIES (Credit Cards Only)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch liabilities - ONLY works for credit accounts.
 * Returns empty liabilities (not an error) if no credit accounts exist.
 * This is the key fix: we gracefully handle the case where an item
 * has only depository accounts.
 */
app.post('/api/plaid/liabilities', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const request = { access_token: accessToken };
        if (req.body.account_ids?.length > 0) {
            request.options = { account_ids: req.body.account_ids };
        }

        const response = await plaidClient.liabilitiesGet(request);

        res.json({
            accounts: response.data.accounts,
            liabilities: response.data.liabilities,
            item: response.data.item,
            request_id: response.data.request_id,
        });
    } catch (error) {
        // If no liable accounts found, return empty liabilities instead of error
        const errorCode = error.response?.data?.error_code;
        if (errorCode === 'NO_LIABILITY_ACCOUNTS' ||
            errorCode === 'PRODUCTS_NOT_SUPPORTED' ||
            errorCode === 'NO_ACCOUNTS') {
            console.log(`[Liabilities] No liable accounts (${errorCode}), returning empty`);
            return res.json({
                accounts: [],
                liabilities: { credit: [], mortgage: [], student: [] },
                item: null,
                request_id: null,
                note: 'No liability accounts found for this item',
            });
        }
        handlePlaidError(res, error, 'get liabilities');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: INVESTMENTS
// ═══════════════════════════════════════════════════════════════════════════════

// Get investment holdings
app.post('/api/plaid/investments/holdings', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;
        const response = await plaidClient.investmentsHoldingsGet({ access_token: accessToken });
        res.json({
            accounts: response.data.accounts,
            holdings: response.data.holdings,
            securities: response.data.securities,
        });
    } catch (error) {
        const errorCode = error.response?.data?.error_code;
        if (errorCode === 'PRODUCTS_NOT_SUPPORTED' || errorCode === 'NO_INVESTMENT_ACCOUNTS') {
            return res.json({
                accounts: [],
                holdings: [],
                securities: [],
                note: 'No investment accounts found for this item',
            });
        }
        console.error('[Plaid] Holdings error:', error.message);
        sendError(res, 500, 'Failed to fetch investment holdings');
    }
});

// Get investment transactions
app.post('/api/plaid/investments/transactions', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;
        const { start_date, end_date } = req.body;
        const response = await plaidClient.investmentsTransactionsGet({
            access_token: accessToken,
            start_date: start_date || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0],
            end_date: end_date || new Date().toISOString().split('T')[0],
        });
        res.json({
            investmentTransactions: response.data.investment_transactions,
            accounts: response.data.accounts,
            securities: response.data.securities,
        });
    } catch (error) {
        const errorCode = error.response?.data?.error_code;
        if (errorCode === 'PRODUCTS_NOT_SUPPORTED' || errorCode === 'NO_INVESTMENT_ACCOUNTS') {
            return res.json({
                investmentTransactions: [],
                accounts: [],
                securities: [],
                note: 'No investment accounts found for this item',
            });
        }
        console.error('[Plaid] Investment transactions error:', error.message);
        sendError(res, 500, 'Failed to fetch investment transactions');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: PAYROLL / INCOME
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/payroll/income', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const response = await plaidClient.creditPayrollIncomeGet({
            access_token: accessToken,
        });

        const items = response.data.items || [];
        const payStubs = [];
        const employers = [];

        for (const item of items) {
            for (const income of (item.payroll_income || [])) {
                for (const stub of (income.pay_stubs || [])) {
                    const period = stub.pay_period_details || {};
                    const employer = stub.employer || {};
                    payStubs.push({
                        pay_date: period.pay_date,
                        start_date: period.start_date,
                        end_date: period.end_date,
                        gross_earnings: period.gross_earnings,
                        net_pay: stub.net_pay?.current_amount ?? 0,
                        pay_frequency: period.pay_frequency,
                        employer_name: employer.name,
                        deductions: (stub.deductions?.breakdown || []).map(d => ({
                            description: d.description || d.type || 'Unknown',
                            current_amount: d.current_amount ?? 0,
                            ytd_amount: d.ytd_amount ?? 0,
                        })),
                        deductions_total: stub.deductions?.total?.current_amount ?? 0,
                        earnings_breakdown: (stub.earnings?.breakdown || []).map(e => ({
                            description: e.description || e.type || 'Unknown',
                            current_amount: e.current_amount ?? 0,
                            hours: e.hours ?? null,
                            rate: e.rate ?? null,
                            ytd_amount: e.ytd_amount ?? 0,
                        })),
                        earnings_total: stub.earnings?.total?.current_amount ?? 0,
                    });
                }
            }
            if (item.institution_name) {
                employers.push({
                    name: item.institution_name,
                    institution_id: item.institution_id,
                    status: item.status,
                });
            }
        }

        res.json({
            pay_stubs: payStubs,
            employers,
            request_id: response.data.request_id,
        });
    } catch (error) {
        const errorCode = error.response?.data?.error_code;
        if (errorCode === 'PRODUCTS_NOT_SUPPORTED' || errorCode === 'PRODUCT_NOT_READY') {
            return res.json({
                pay_stubs: [],
                employers: [],
                request_id: null,
                note: errorCode === 'PRODUCT_NOT_READY'
                    ? 'Payroll data is still being processed. Try again in a few minutes.'
                    : 'Payroll product not supported for this institution.',
            });
        }
        handlePlaidError(res, error, 'get payroll income');
    }
});

app.post('/api/plaid/payroll/employment', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const response = await plaidClient.creditEmploymentGet({
            access_token: accessToken,
        });

        const employments = (response.data.items || []).flatMap(item =>
            (item.employments || []).map(emp => ({
                employer_name: emp.employer?.name,
                title: emp.title,
                start_date: emp.start_date,
                end_date: emp.end_date,
                status: emp.status,
                pay_frequency: emp.pay_frequency,
                annual_salary: emp.annual_salary,
            }))
        );

        res.json({
            employments,
            request_id: response.data.request_id,
        });
    } catch (error) {
        const errorCode = error.response?.data?.error_code;
        if (errorCode === 'PRODUCTS_NOT_SUPPORTED') {
            return res.json({ employments: [], request_id: null });
        }
        handlePlaidError(res, error, 'get employment');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: STATEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/statements/list', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const response = await plaidClient.statementsList({
            access_token: accessToken,
        });

        res.json({
            accounts: response.data.accounts,
            institution_id: response.data.institution_id,
            institution_name: response.data.institution_name,
            item_id: response.data.item_id,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'list statements');
    }
});

app.post('/api/plaid/statements/download', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;
        if (!requireFields(req, res, ['statement_id'])) return;
        if (!isValidId(req.body.statement_id)) return sendError(res, 400, 'Invalid statement_id format');

        const response = await plaidClient.statementsDownload({
            access_token: accessToken,
            statement_id: req.body.statement_id,
        });

        const pdfBase64 = Buffer.from(response.data).toString('base64');

        res.json({
            pdf_base64: pdfBase64,
            content_type: 'application/pdf',
        });
    } catch (error) {
        handlePlaidError(res, error, 'download statement');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: IDENTITY
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/identity', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const request = { access_token: accessToken };
        if (req.body.account_ids?.length > 0) {
            request.options = { account_ids: req.body.account_ids };
        }

        const response = await plaidClient.identityGet(request);

        res.json({
            accounts: response.data.accounts,
            item: response.data.item,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'get identity');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: ITEM MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/item', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const response = await plaidClient.itemGet({
            access_token: accessToken,
        });

        res.json({
            item: response.data.item,
            status: response.data.status,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'get item');
    }
});

app.post('/api/plaid/item/refresh', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const response = await plaidClient.transactionsRefresh({
            access_token: accessToken,
        });

        res.json({
            refreshed: true,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'refresh item');
    }
});

app.post('/api/plaid/item/remove', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accessToken = await resolveAccessToken(req, res);
        if (!accessToken) return;

        const response = await plaidClient.itemRemove({
            access_token: accessToken,
        });

        // Clean up server-side token
        await removeAccessToken(req.supabaseUserId, req.body.item_id);

        res.json({
            removed: true,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'remove item');
    }
});

// List user's connected items
app.get('/api/plaid/items', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const itemIds = await getAllItemIds(req.supabaseUserId);
        res.json({ item_ids: itemIds });
    } catch (error) {
        console.error('[Supabase Error] Get items:', error.message);
        sendError(res, 500, 'Failed to retrieve connected accounts');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: INSTITUTION DETAILS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/plaid/institution', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!requireFields(req, res, ['institution_id'])) return;
        if (!isValidId(req.body.institution_id)) return sendError(res, 400, 'Invalid institution_id format');

        const response = await plaidClient.institutionsGetById({
            institution_id: req.body.institution_id,
            country_codes: [CountryCode.Us],
            options: {
                include_optional_metadata: true,
                include_payment_initiation_metadata: false,
            },
        });

        res.json({
            institution: response.data.institution,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'get institution');
    }
});

// Categories
app.get('/api/plaid/categories', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const response = await plaidClient.categoriesGet({});
        res.json({
            categories: response.data.categories,
            request_id: response.data.request_id,
        });
    } catch (error) {
        handlePlaidError(res, error, 'get categories');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAID: WEBHOOKS
// ═══════════════════════════════════════════════════════════════════════════════

// Webhook verification key cache (keys are cached per key_id)
const webhookKeyCache = new Map();

/**
 * Verify Plaid webhook signature.
 * Plaid sends a signed JWT in the 'Plaid-Verification' header.
 * We fetch the public key from Plaid, then verify the JWT and its body hash.
 */
async function verifyPlaidWebhook(req) {
    const verificationHeader = req.headers['plaid-verification'];
    if (!verificationHeader) {
        throw new Error('Missing Plaid-Verification header');
    }

    // Decode JWT header to get key_id (without verifying yet)
    const [headerB64] = verificationHeader.split('.');
    const headerJson = Buffer.from(headerB64, 'base64').toString('utf8');
    const { kid: keyId, alg } = JSON.parse(headerJson);

    if (!keyId) throw new Error('JWT header missing kid');

    // Fetch (and cache) the public key from Plaid
    let publicKey = webhookKeyCache.get(keyId);
    if (!publicKey) {
        const response = await plaidClient.webhookVerificationKeyGet({ key_id: keyId });
        const key = response.data.key;
        // Convert JWK to PEM using Node.js built-in crypto
        const { createPublicKey } = require('crypto');
        publicKey = createPublicKey({ key, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
        // Cache for 24 hours - Plaid rotates keys infrequently
        webhookKeyCache.set(keyId, publicKey);
        setTimeout(() => webhookKeyCache.delete(keyId), 24 * 60 * 60 * 1000);
    }

    // Verify JWT signature and expiry
    const decoded = jwt.verify(verificationHeader, publicKey, { algorithms: ['ES256'] });

    // Verify the body hash matches (Plaid includes sha256 of raw body in JWT)
    const { createHash } = require('crypto');
    // Use actual raw body buffer (captured by express.json verify callback), not re-serialized JSON
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    if (decoded.request_body_sha256 !== bodyHash) {
        throw new Error('Webhook body hash mismatch');
    }

    return true;
}

app.post('/api/plaid/webhook', async (req, res) => {
    try {
        await verifyPlaidWebhook(req);
    } catch (verifyError) {
        console.error('[Webhook] Signature verification failed:', verifyError.message);
        return sendError(res, 401, 'Webhook verification failed');
    }

    const { webhook_type, webhook_code, item_id, error: webhookError } = req.body;
    if (!webhook_type || !webhook_code) return sendError(res, 400, 'Invalid webhook payload');

    console.log(`[Webhook] ${webhook_type} - ${webhook_code} for item ${item_id}`);
    if (webhookError) console.error('[Webhook Error]', webhookError);

    // Ack immediately; all work is async so Plaid's retry window isn't affected.
    res.json({ received: true, timestamp: new Date().toISOString() });

    (async () => {
        try {
            const ledger = require('./sync-ledger');
            const executor = require('./sync-executor');

            // Resolve user_id + access_token from plaid_tokens (authoritative token store).
            const { data: tokRow } = await supabaseDb.supabase
                .from('plaid_tokens')
                .select('user_id, access_token, institution_name')
                .eq('item_id', item_id)
                .maybeSingle();
            if (!tokRow?.user_id || !tokRow?.access_token) {
                console.warn('[Webhook] No token/user for item', item_id);
                return;
            }
            const userId = tokRow.user_id;

            // Always ensure a ledger row exists — upsert is idempotent thanks to
            // onConflict:'item_id'. Cheaper than get-then-upsert and race-safe.
            await ledger.upsertItem({
                itemId: item_id,
                userId,
                institutionName: tokRow.institution_name || null,
            });

            if (webhook_type === 'TRANSACTIONS' && (
                webhook_code === 'SYNC_UPDATES_AVAILABLE' ||
                webhook_code === 'DEFAULT_UPDATE' ||
                webhook_code === 'INITIAL_UPDATE' ||
                webhook_code === 'HISTORICAL_UPDATE'
            )) {
                const counts = await executor.syncTransactions({
                    itemId: item_id, accessToken: tokRow.access_token, userId,
                });
                await executor.pushSyncUpdated({
                    userId, itemId: item_id, dataTypes: ['transactions'], counts,
                });
            } else if (webhook_type === 'TRANSACTIONS' && webhook_code === 'TRANSACTIONS_REMOVED') {
                const removed = (req.body.removed_transactions || []).map(id => ({ transaction_id: id }));
                const { removed: removedCount } = await executor.deleteRemovedTransactions({ userId, removed });
                await executor.pushSyncUpdated({
                    userId, itemId: item_id, dataTypes: ['transactions'],
                    counts: { added: 0, modified: 0, removed: removedCount },
                });
            } else if (webhook_type === 'ITEM' && webhook_code === 'ERROR' && webhookError?.error_code === 'ITEM_LOGIN_REQUIRED') {
                await ledger.updateSyncState(item_id, {
                    status: 'login_required',
                    error_code: 'ITEM_LOGIN_REQUIRED',
                    error_message: webhookError.error_message,
                });
                // User-visible reconnect push deferred to a later task (banner in app covers this).
            } else if (webhook_type === 'ITEM' && (webhook_code === 'ERROR' || webhook_code === 'PENDING_EXPIRATION')) {
                await ledger.updateSyncState(item_id, {
                    status: 'error',
                    error_code: webhookError?.error_code || webhook_code,
                    error_message: webhookError?.error_message || null,
                });
            } else if (webhook_type === 'ITEM' && webhook_code === 'NEW_ACCOUNTS_AVAILABLE') {
                // Future: prompt re-link via Update Mode. For now just log.
                console.log('[Webhook] NEW_ACCOUNTS_AVAILABLE for item', item_id);
            } else {
                console.log('[Webhook] Unhandled code, no action taken:', webhook_type, webhook_code);
            }

            // Preserve existing post-sync AI processing (unchanged — it already reads Supabase).
            if (webhook_type === 'TRANSACTIONS' && webhook_code !== 'TRANSACTIONS_REMOVED') {
                await Promise.all([
                    aiChat.refreshFinancialProfile(userId).catch(e =>
                        console.warn('[Webhook AI] Profile refresh failed:', e.message)),
                    aiChat.generateInsights(userId).catch(e =>
                        console.warn('[Webhook AI] Insights generation failed:', e.message)),
                ]);
            }

        } catch (e) {
            console.error('[Webhook post-processing]', e);
        }
    })();
});

// ═══════════════════════════════════════════════════════════════════════════════
// MX PLATFORM API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MX integration for institutions and cards that Plaid doesn't support.
 * Particularly useful for store cards (Macy's, Target, etc.)
 *
 * MX uses a Widget-based connection flow:
 * 1. Create MX user
 * 2. Get widget URL for user to connect
 * 3. Fetch accounts/transactions after connection
 */

// Helper: make MX API request
async function mxFetch(path, method = 'GET', body = null) {
    if (!isMxConfigured()) {
        throw new Error('MX is not configured. Set MX_API_KEY and MX_CLIENT_ID.');
    }

    const options = {
        method,
        headers: getMxHeaders(),
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetchWithTimeout(`${MX_BASE_URL}${path}`, options, 20000);
    const data = await response.json();

    if (!response.ok) {
        const error = new Error(data.error?.message || `MX API error: ${response.status}`);
        error.status = response.status;
        error.mxError = data.error;
        throw error;
    }

    return data;
}

// MX Status
app.get('/api/mx/status', (req, res) => {
    res.json({
        configured: isMxConfigured(),
        environment: MX_ENV,
    });
});

// Create MX User
app.post('/api/mx/users', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) {
            return sendError(res, 503, 'MX integration not configured');
        }

        const { id, email, metadata } = req.body;

        // Check if user already has an MX account
        const existingGuid = await getMxUserGuid(req.supabaseUserId);
        if (existingGuid) {
            return res.json({ user: { guid: existingGuid } });
        }

        const data = await mxFetch('/users', 'POST', {
            user: {
                id: id || `cc-user-${Date.now()}`,
                email: email || null,
                metadata: metadata || null,
            },
        });

        // Store userId -> MX user GUID mapping in Supabase
        await storeMxUserGuid(req.supabaseUserId, data.user.guid);

        res.json({ user: data.user });
    } catch (error) {
        console.error('[MX Error] Create user:', error.message);
        sendError(res, error.status || 500, 'Failed to create MX user', error.message);
    }
});

// Get MX Connect Widget URL
app.post('/api/mx/connect-widget', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) return sendError(res, 503, 'MX integration not configured');

        const user_guid = await resolveMxUserGuid(req, res);
        if (!user_guid) return;

        const { color_scheme, mode, current_member_guid } = req.body;

        const widgetRequest = {
            widget_url: {
                widget_type: 'connect_widget',
                color_scheme: color_scheme || 'dark',
                mode: mode || 'verification',
                is_mobile_webview: true,
            },
        };

        if (current_member_guid) {
            if (!isValidId(current_member_guid)) return sendError(res, 400, 'Invalid member_guid format');
            widgetRequest.widget_url.current_member_guid = current_member_guid;
        }

        const data = await mxFetch(`/users/${user_guid}/widget_urls`, 'POST', widgetRequest);
        res.json({ widget_url: data.widget_url });
    } catch (error) {
        console.error('[MX Error] Connect widget:', error.message);
        sendError(res, error.status || 500, 'Failed to get MX widget URL');
    }
});

// List MX Members (connected institutions)
app.post('/api/mx/members', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) return sendError(res, 503, 'MX integration not configured');

        const user_guid = await resolveMxUserGuid(req, res);
        if (!user_guid) return;

        const data = await mxFetch(`/users/${user_guid}/members`);
        res.json({ members: data.members || [] });
    } catch (error) {
        console.error('[MX Error] List members:', error.message);
        sendError(res, error.status || 500, 'Failed to list MX members');
    }
});

// Get MX Member details (connection status)
app.post('/api/mx/members/status', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) return sendError(res, 503, 'MX integration not configured');

        const user_guid = await resolveMxUserGuid(req, res);
        if (!user_guid) return;

        if (!requireFields(req, res, ['member_guid'])) return;
        if (!isValidId(req.body.member_guid)) return sendError(res, 400, 'Invalid member_guid format');

        const data = await mxFetch(`/users/${user_guid}/members/${req.body.member_guid}/status`);
        res.json({ member: data.member });
    } catch (error) {
        console.error('[MX Error] Member status:', error.message);
        sendError(res, error.status || 500, 'Failed to get MX member status');
    }
});

// Aggregate MX Member (trigger data refresh)
app.post('/api/mx/members/aggregate', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) return sendError(res, 503, 'MX integration not configured');

        const user_guid = await resolveMxUserGuid(req, res);
        if (!user_guid) return;

        if (!requireFields(req, res, ['member_guid'])) return;
        if (!isValidId(req.body.member_guid)) return sendError(res, 400, 'Invalid member_guid format');

        const data = await mxFetch(`/users/${user_guid}/members/${req.body.member_guid}/aggregate`, 'POST');
        res.json({ member: data.member });
    } catch (error) {
        console.error('[MX Error] Aggregate member:', error.message);
        sendError(res, error.status || 500, 'Failed to aggregate MX member');
    }
});

// Get MX Accounts
app.post('/api/mx/accounts', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) return sendError(res, 503, 'MX integration not configured');

        const user_guid = await resolveMxUserGuid(req, res);
        if (!user_guid) return;

        const { member_guid } = req.body;

        let path;
        if (member_guid) {
            if (!isValidId(member_guid)) return sendError(res, 400, 'Invalid member_guid format');
            path = `/users/${user_guid}/members/${member_guid}/accounts`;
        } else {
            path = `/users/${user_guid}/accounts`;
        }

        const data = await mxFetch(path);
        res.json({ accounts: data.accounts || [] });
    } catch (error) {
        console.error('[MX Error] Get accounts:', error.message);
        sendError(res, error.status || 500, 'Failed to get MX accounts');
    }
});

// Get MX Transactions
app.post('/api/mx/transactions', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) return sendError(res, 503, 'MX integration not configured');

        const user_guid = await resolveMxUserGuid(req, res);
        if (!user_guid) return;

        const { account_guid, from_date, to_date, page, records_per_page } = req.body;

        let path;
        if (account_guid) {
            if (!isValidId(account_guid)) return sendError(res, 400, 'Invalid account_guid format');
            path = `/users/${user_guid}/accounts/${account_guid}/transactions`;
        } else {
            path = `/users/${user_guid}/transactions`;
        }

        const params = new URLSearchParams();
        // Validate date format (YYYY-MM-DD)
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (from_date) {
            if (!dateRegex.test(from_date)) return sendError(res, 400, 'Invalid from_date format (use YYYY-MM-DD)');
            params.append('from_date', from_date);
        }
        if (to_date) {
            if (!dateRegex.test(to_date)) return sendError(res, 400, 'Invalid to_date format (use YYYY-MM-DD)');
            params.append('to_date', to_date);
        }
        // Validate pagination params are positive integers
        if (page !== undefined) {
            const p = parseInt(page);
            if (isNaN(p) || p < 1) return sendError(res, 400, 'page must be a positive integer');
            params.append('page', p);
        }
        if (records_per_page !== undefined) {
            const rpp = parseInt(records_per_page);
            if (isNaN(rpp) || rpp < 1 || rpp > 500) return sendError(res, 400, 'records_per_page must be 1-500');
            params.append('records_per_page', rpp);
        }

        const queryString = params.toString();
        if (queryString) path += `?${queryString}`;

        const data = await mxFetch(path);
        res.json({
            transactions: data.transactions || [],
            pagination: data.pagination || null,
        });
    } catch (error) {
        console.error('[MX Error] Get transactions:', error.message);
        sendError(res, error.status || 500, 'Failed to get MX transactions');
    }
});

// Search MX Institutions (no user_guid needed - public data)
app.post('/api/mx/institutions/search', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) return sendError(res, 503, 'MX integration not configured');

        const { name, page, records_per_page, supports_account_identification } = req.body;

        let path = '/institutions';
        const params = new URLSearchParams();
        if (name) {
            if (typeof name !== 'string' || name.length > 200) return sendError(res, 400, 'Invalid name parameter');
            params.append('name', name);
        }
        if (page !== undefined) {
            const p = parseInt(page);
            if (isNaN(p) || p < 1) return sendError(res, 400, 'page must be a positive integer');
            params.append('page', p);
        }
        if (records_per_page !== undefined) {
            const rpp = parseInt(records_per_page);
            if (isNaN(rpp) || rpp < 1 || rpp > 500) return sendError(res, 400, 'records_per_page must be 1-500');
            params.append('records_per_page', rpp);
        }
        if (supports_account_identification) params.append('supports_account_identification', 'true');

        const queryString = params.toString();
        if (queryString) path += `?${queryString}`;

        const data = await mxFetch(path);
        res.json({
            institutions: data.institutions || [],
            pagination: data.pagination || null,
        });
    } catch (error) {
        console.error('[MX Error] Search institutions:', error.message);
        sendError(res, error.status || 500, 'Failed to search MX institutions');
    }
});

// Delete MX Member (disconnect institution)
app.post('/api/mx/members/delete', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) return sendError(res, 503, 'MX integration not configured');

        const user_guid = await resolveMxUserGuid(req, res);
        if (!user_guid) return;

        if (!requireFields(req, res, ['member_guid'])) return;
        if (!isValidId(req.body.member_guid)) return sendError(res, 400, 'Invalid member_guid format');

        await mxFetch(`/users/${user_guid}/members/${req.body.member_guid}`, 'DELETE');
        res.json({ deleted: true });
    } catch (error) {
        console.error('[MX Error] Delete member:', error.message);
        sendError(res, error.status || 500, 'Failed to delete MX member');
    }
});

// Delete MX User
app.post('/api/mx/users/delete', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        if (!isMxConfigured()) return sendError(res, 503, 'MX integration not configured');

        const user_guid = await resolveMxUserGuid(req, res);
        if (!user_guid) return;

        await mxFetch(`/users/${user_guid}`, 'DELETE');

        // Remove the MX GUID from Supabase users table
        await supabaseDb.storeMXUserGuid(req.userId, null);

        res.json({ deleted: true });
    } catch (error) {
        console.error('[MX Error] Delete user:', error.message);
        sendError(res, error.status || 500, 'Failed to delete MX user');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AI PROXY — Gemini 2.0 Flash (primary) + Groq fallback
// API keys never leave the server
// ═══════════════════════════════════════════════════════════════════════════════

// ── Gemini ────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL    = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── Groq (fallback) ───────────────────────────────────────────────────────────
const GROQ_API_KEY  = process.env.GROQ_API_KEY;
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL    = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

/**
 * Convert OpenAI-style messages → Gemini API format.
 * Gemini requires: system instruction separate, roles "user"/"model" only.
 */
function toGeminiFormat(messages) {
    let systemText = null;
    const contents = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            // Accumulate all system messages into one instruction block
            systemText = systemText ? `${systemText}\n\n${msg.content}` : msg.content;
        } else {
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }],
            });
        }
    }

    // Gemini requires conversation to start with a "user" turn
    if (contents.length === 0 || contents[0].role !== 'user') {
        contents.unshift({ role: 'user', parts: [{ text: '.' }] });
    }

    return { systemText, contents };
}

/**
 * Call Gemini 2.0 Flash. Returns the text response string.
 */
async function callGemini(messages, maxTokens, temperature) {
    const { systemText, contents } = toGeminiFormat(messages);
    const safeTemp = typeof temperature === 'number' ? Math.min(Math.max(temperature, 0), 2) : 0.4;
    const safeTokens = typeof maxTokens === 'number' ? Math.min(maxTokens, 8192) : 1000;

    const body = {
        contents,
        generationConfig: {
            maxOutputTokens: safeTokens,
            temperature: safeTemp,
        },
        // Don't block anything — this is a personal finance app with no harmful content
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_NONE' },
        ],
    };

    if (systemText) {
        body.system_instruction = { parts: [{ text: systemText }] };
    }

    const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, 30000);

    const data = await response.json();

    if (!response.ok) {
        throw new Error(`Gemini ${response.status}: ${data.error?.message || 'unknown error'}`);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned empty response');
    return text;
}

/**
 * Call Groq (OpenAI-compatible). Returns the text response string.
 * Used as fallback when Gemini fails, or when streaming is requested.
 */
async function callGroq(messages, maxTokens, temperature) {
    const safeTemp   = typeof temperature === 'number' ? Math.min(Math.max(temperature, 0), 2) : 0.4;
    const safeTokens = typeof maxTokens   === 'number' ? Math.min(maxTokens, 4096) : 1000;

    const response = await fetchWithTimeout(GROQ_BASE_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages,
            temperature: safeTemp,
            max_tokens: safeTokens,
        }),
    }, 15000);

    const data = await response.json();
    if (!response.ok) throw new Error(`Groq ${response.status}: ${data.error?.message || 'unknown error'}`);

    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Groq returned empty response');
    return text;
}

// ─── Agentic AI Chat (with tool-use) ─────────────────────────────────────────

/**
 * POST /api/ai/chat — Non-streaming agentic chat.
 * Requires auth — tool calls need real user data.
 * Body: { message: string, session_id?: string }
 */
app.post('/api/ai/chat', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { message, session_id } = req.body;

        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return sendError(res, 400, 'message is required');
        }
        if (message.length > 10000) {
            return sendError(res, 400, 'Message too long (max 10000 characters)');
        }

        const result = await aiChat.handleChat(
            req.supabaseUserId,
            message.trim(),
            session_id || null
        );

        res.json(result);

    } catch (error) {
        console.error('[AI Chat Error]', error.message);
        sendError(res, 500, 'AI service temporarily unavailable');
    }
});

/**
 * POST /api/ai/chat/stream — SSE streaming agentic chat.
 * Streams tool progress events and text chunks in real-time.
 * Body: { message: string, session_id?: string }
 */
app.post('/api/ai/chat/stream', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { message, session_id } = req.body;

        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return sendError(res, 400, 'message is required');
        }
        if (message.length > 10000) {
            return sendError(res, 400, 'Message too long (max 10000 characters)');
        }

        await aiChat.handleChatStream(
            req.supabaseUserId,
            message.trim(),
            session_id || null,
            res
        );

    } catch (error) {
        console.error('[AI Stream Error]', error.message);
        if (!res.headersSent) {
            sendError(res, 500, 'AI service temporarily unavailable');
        }
    }
});

/**
 * GET /api/ai/insights — Get proactive AI insights for the user.
 */
app.get('/api/ai/insights', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { data, error } = await supabaseDb.supabase
            .from('ai_insights')
            .select('*')
            .eq('user_id', req.supabaseUserId)
            .eq('is_dismissed', false)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;
        res.json({ insights: data || [] });
    } catch (error) {
        console.error('[Insights Error]', error.message);
        sendError(res, 500, 'Failed to fetch insights');
    }
});

/**
 * POST /api/ai/insights/dismiss — Dismiss an insight.
 */
app.post('/api/ai/insights/dismiss', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { insight_id } = req.body;
        if (!insight_id) return sendError(res, 400, 'insight_id is required');

        await supabaseDb.supabase
            .from('ai_insights')
            .update({ is_dismissed: true })
            .eq('id', insight_id)
            .eq('user_id', req.supabaseUserId);

        res.json({ success: true });
    } catch (error) {
        sendError(res, 500, 'Failed to dismiss insight');
    }
});

/**
 * POST /api/ai/refresh-profile — Trigger financial profile refresh.
 */
app.post('/api/ai/refresh-profile', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const profile = await aiChat.refreshFinancialProfile(req.supabaseUserId);
        res.json({ success: true, profile });
    } catch (error) {
        console.error('[Profile Error]', error.message);
        sendError(res, 500, 'Failed to refresh profile');
    }
});

/**
 * POST /api/ai/categorize — Trigger auto-categorization for a user's transactions.
 */
app.post('/api/ai/categorize', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { transactions } = req.body;
        if (!transactions || !Array.isArray(transactions)) {
            return sendError(res, 400, 'transactions array is required');
        }

        const results = await aiChat.autoCategorize(req.supabaseUserId, transactions);
        res.json({ success: true, categorized: results?.length || 0 });
    } catch (error) {
        console.error('[Categorize Error]', error.message);
        sendError(res, 500, 'Failed to categorize');
    }
});

/**
 * POST /api/ai/merchant-correction — Save a user's merchant category correction.
 */
app.post('/api/ai/merchant-correction', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { merchant_name, category, display_name } = req.body;
        if (!merchant_name || !category) {
            return sendError(res, 400, 'merchant_name and category are required');
        }

        const { saveUserCorrection } = require('./ai-tools');
        await saveUserCorrection(req.supabaseUserId, merchant_name, category, display_name);
        res.json({ success: true });
    } catch (error) {
        console.error('[Correction Error]', error.message);
        sendError(res, 500, 'Failed to save correction');
    }
});

/**
 * GET /api/ai/sessions — Get user's chat sessions.
 */
app.get('/api/ai/sessions', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { data, error } = await supabaseDb.supabase
            .from('chat_sessions')
            .select('id, title, message_count, created_at, updated_at')
            .eq('user_id', req.supabaseUserId)
            .order('updated_at', { ascending: false })
            .limit(20);

        if (error) throw error;
        res.json({ sessions: data || [] });
    } catch (error) {
        sendError(res, 500, 'Failed to fetch sessions');
    }
});

/**
 * GET /api/ai/session/:sessionId/messages — Get messages for a chat session.
 */
app.get('/api/ai/session/:sessionId/messages', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!sessionId || sessionId.length < 10) {
            return sendError(res, 400, 'Invalid session ID');
        }

        const { data, error } = await supabaseDb.supabase
            .from('chat_messages')
            .select('id, role, content, tool_calls, tool_results, created_at')
            .eq('user_id', req.supabaseUserId)
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true })
            .limit(100);

        if (error) throw error;
        res.json({ messages: data || [] });
    } catch (error) {
        sendError(res, 500, 'Failed to fetch messages');
    }
});

/**
 * POST /api/ai/memory — Save a user memory/preference.
 */
app.post('/api/ai/memory', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { memory_type, key, value } = req.body;
        if (!memory_type || !key || !value) {
            return sendError(res, 400, 'memory_type, key, and value are required');
        }

        await supabaseDb.supabase.from('ai_memory').upsert({
            user_id: req.supabaseUserId,
            memory_type,
            key,
            value,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,memory_type,key' });

        res.json({ success: true });
    } catch (error) {
        sendError(res, 500, 'Failed to save memory');
    }
});

// ─── Legacy AI Chat (simple proxy, kept for backward compatibility) ──────────

app.post('/api/ai/chat/legacy', optionalAuth, async (req, res) => {
    try {
        const { messages, max_tokens, temperature } = req.body;

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return sendError(res, 400, 'messages array is required');
        }
        if (messages.length > 50) {
            return sendError(res, 400, 'Too many messages (max 50)');
        }

        if (!GEMINI_API_KEY && !GROQ_API_KEY) {
            return sendError(res, 503, 'AI service not configured');
        }

        let content = null;
        let provider = null;

        if (GEMINI_API_KEY) {
            try {
                content  = await callGemini(messages, max_tokens, temperature);
                provider = 'gemini';
            } catch (geminiErr) {
                console.warn('[AI Legacy] Gemini failed, falling back to Groq:', geminiErr.message);
            }
        }
        if (!content && GROQ_API_KEY) {
            try {
                content  = await callGroq(messages, max_tokens, temperature);
                provider = 'groq';
            } catch (groqErr) {
                return sendError(res, 500, 'AI service temporarily unavailable');
            }
        }
        if (!content) return sendError(res, 503, 'AI service not configured');

        res.json({ content, provider });
    } catch (error) {
        sendError(res, 500, 'AI service temporarily unavailable');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL VERIFICATION — Custom branded emails via SMTP
// ═══════════════════════════════════════════════════════════════════════════════

// SMTP Transporter (configured from env or defaults)
const SMTP_CONFIGURED = !!(process.env.SMTP_PASS);
const smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // STARTTLS
    auth: {
        user: process.env.SMTP_USER || 'pulsecreditverify@gmail.com',
        pass: process.env.SMTP_PASS || '',
    },
});

// Verify SMTP connection on startup
if (SMTP_CONFIGURED) {
    smtpTransporter.verify()
        .then(() => console.log('[SMTP] ✓ Connection verified'))
        .catch(err => console.error('[SMTP] ✗ Connection failed:', err.message));
} else {
    console.warn('[SMTP] ⚠️ SMTP_PASS not set — verification emails will use Firebase fallback');
}

/** Escape HTML special characters to prevent XSS in email templates */
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Build the branded HTML email template
 */
function buildVerificationEmail(displayName, verificationLink) {
    const name = escapeHtml(displayName || 'there');
    verificationLink = escapeHtml(verificationLink);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Verify your email — ClaudeCredit</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a12;padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:480px;" cellpadding="0" cellspacing="0">

<!-- Logo -->
<tr><td align="center" style="padding-bottom:32px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="background:linear-gradient(135deg,#4070ff,#7040cc);border-radius:12px;width:40px;height:40px;text-align:center;line-height:40px;font-size:20px;">💳</td>
    <td style="padding-left:12px;font-size:22px;font-weight:700;color:#7090ff;letter-spacing:-0.3px;">ClaudeCredit</td>
  </tr></table>
</td></tr>

<!-- Card body -->
<tr><td style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:44px 36px;">

  <!-- Icon -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding-bottom:28px;">
    <div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,rgba(64,112,255,0.15),rgba(112,64,204,0.15));border:1px solid rgba(64,112,255,0.2);text-align:center;line-height:72px;font-size:32px;">✉️</div>
  </td></tr>
  </table>

  <!-- Title -->
  <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#ffffff;text-align:center;letter-spacing:-0.5px;">
    Verify Your Email
  </h1>

  <!-- Body -->
  <p style="margin:0 0 8px;font-size:15px;color:rgba(255,255,255,0.55);text-align:center;line-height:1.7;">
    Hey ${name}! Welcome to ClaudeCredit.
  </p>
  <p style="margin:0 0 32px;font-size:15px;color:rgba(255,255,255,0.55);text-align:center;line-height:1.7;">
    Tap the button below to verify your email and start managing your credit cards, tracking spending, and earning rewards.
  </p>

  <!-- CTA button -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center">
    <a href="${verificationLink}" target="_blank"
       style="display:inline-block;padding:15px 40px;background:linear-gradient(135deg,#4070ff,#7040cc);color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:14px;letter-spacing:0.2px;">
      Verify My Email
    </a>
  </td></tr>
  </table>

  <!-- Fallback link -->
  <p style="margin:28px 0 0;font-size:12px;color:rgba(255,255,255,0.3);text-align:center;line-height:1.6;word-break:break-all;">
    If the button doesn't work, copy and paste this link:<br/>
    <a href="${verificationLink}" style="color:rgba(100,140,255,0.7);text-decoration:none;">${verificationLink}</a>
  </p>

</td></tr>

<!-- Features row -->
<tr><td style="padding-top:24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td width="33%" align="center" style="padding:12px 4px;">
      <div style="font-size:24px;margin-bottom:6px;">💳</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.35);font-weight:600;">All Your Cards</div>
    </td>
    <td width="33%" align="center" style="padding:12px 4px;">
      <div style="font-size:24px;margin-bottom:6px;">📊</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.35);font-weight:600;">Smart Insights</div>
    </td>
    <td width="33%" align="center" style="padding:12px 4px;">
      <div style="font-size:24px;margin-bottom:6px;">🎁</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.35);font-weight:600;">Earn Rewards</div>
    </td>
  </tr>
  </table>
</td></tr>

<!-- Footer -->
<tr><td align="center" style="padding-top:32px;">
  <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.2);line-height:1.6;">
    © 2026 ClaudeCredit · You received this because you signed up for ClaudeCredit.<br/>
    If you didn't create an account, you can safely ignore this email.
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildPasswordResetEmail(displayName, resetLink) {
    const name = escapeHtml(displayName || 'there');
    resetLink = escapeHtml(resetLink);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Reset your password — ClaudeCredit</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a12;padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:480px;" cellpadding="0" cellspacing="0">

<!-- Logo -->
<tr><td align="center" style="padding-bottom:32px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="background:linear-gradient(135deg,#4070ff,#7040cc);border-radius:12px;width:40px;height:40px;text-align:center;line-height:40px;font-size:20px;">💳</td>
    <td style="padding-left:12px;font-size:22px;font-weight:700;color:#7090ff;letter-spacing:-0.3px;">ClaudeCredit</td>
  </tr></table>
</td></tr>

<!-- Card body -->
<tr><td style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:44px 36px;">

  <!-- Icon -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding-bottom:28px;">
    <div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,rgba(255,179,64,0.15),rgba(255,120,50,0.15));border:1px solid rgba(255,179,64,0.2);text-align:center;line-height:72px;font-size:32px;">🔑</div>
  </td></tr>
  </table>

  <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#ffffff;text-align:center;letter-spacing:-0.5px;">
    Reset Your Password
  </h1>

  <p style="margin:0 0 32px;font-size:15px;color:rgba(255,255,255,0.55);text-align:center;line-height:1.7;">
    Hey ${name}, we received a request to reset your ClaudeCredit password. Tap the button below to create a new one.
  </p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center">
    <a href="${resetLink}" target="_blank"
       style="display:inline-block;padding:15px 40px;background:linear-gradient(135deg,#ff9500,#ff6b35);color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:14px;letter-spacing:0.2px;">
      Reset Password
    </a>
  </td></tr>
  </table>

  <p style="margin:28px 0 0;font-size:12px;color:rgba(255,255,255,0.3);text-align:center;line-height:1.6;word-break:break-all;">
    If the button doesn't work, copy and paste this link:<br/>
    <a href="${resetLink}" style="color:rgba(100,140,255,0.7);text-decoration:none;">${resetLink}</a>
  </p>

  <p style="margin:20px 0 0;font-size:13px;color:rgba(255,255,255,0.35);text-align:center;line-height:1.6;">
    If you didn't request this, you can safely ignore this email. Your password won't change.
  </p>

</td></tr>

<!-- Footer -->
<tr><td align="center" style="padding-top:32px;">
  <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.2);line-height:1.6;">
    © 2026 ClaudeCredit · This link expires in 1 hour.
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// Stricter rate limit for auth endpoints (5 requests per minute per IP)
const authRateLimitMap = new Map();
function authRateLimit(req, res, next) {
    const key = `auth:${req.ip || 'unknown'}`;
    const now = Date.now();
    const entry = authRateLimitMap.get(key) || { count: 0, resetAt: now + 60000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
    entry.count++;
    authRateLimitMap.set(key, entry);
    if (authRateLimitMap.size > 5000) authRateLimitMap.delete(authRateLimitMap.keys().next().value);
    if (entry.count > 5) {
        res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
        return sendError(res, 429, 'Too many requests. Please try again later.');
    }
    next();
}
setInterval(() => { const now = Date.now(); for (const [k, v] of authRateLimitMap) { if (now > v.resetAt) authRateLimitMap.delete(k); } }, 60000);

/** Mask email for logging: kr***@gmail.com */
function maskEmail(email) {
    if (!email) return 'unknown';
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * POST /api/auth/send-verification
 * Generates a verification link via Firebase Admin SDK and sends a custom branded email.
 * Body: { email: string }
 * No auth required (user just signed up and isn't authenticated yet)
 */
app.post('/api/auth/send-verification', authRateLimit, async (req, res) => {
    const { email } = req.body;
    if (!email) return sendError(res, 400, 'Email is required');

    try {
        // Get user record for display name
        const userRecord = await admin.auth().getUserByEmail(email);
        const displayName = userRecord.displayName || null;

        // Generate verification link with custom action URL
        const actionCodeSettings = {
            url: 'https://claudec-839c6.web.app/__/auth/action',
            handleCodeInApp: false,
        };
        const verificationLink = await admin.auth().generateEmailVerificationLink(email, actionCodeSettings);

        if (SMTP_CONFIGURED) {
            // Send custom HTML email via SMTP
            await smtpTransporter.sendMail({
                from: '"ClaudeCredit" <pulsecreditverify@gmail.com>',
                to: email,
                subject: 'Verify your email for ClaudeCredit',
                html: buildVerificationEmail(displayName, verificationLink),
            });
            console.log(`[Email] Verification email sent via SMTP to ${maskEmail(email)}`);
        } else {
            console.warn(`[Email] SMTP not configured, using fallback for ${maskEmail(email)}`);
            try {
                await smtpTransporter.sendMail({
                    from: '"ClaudeCredit" <pulsecreditverify@gmail.com>',
                    to: email,
                    subject: 'Verify your email for ClaudeCredit',
                    text: `Hi ${escapeHtml(displayName || 'there')},\n\nPlease verify your email by clicking this link:\n${verificationLink}\n\nThanks,\nClaudeCredit Team`,
                });
            } catch (smtpErr) {
                console.error('[Email] SMTP fallback also failed:', smtpErr.message);
                return res.json({
                    success: true,
                    message: 'Verification link generated. Check your email.',
                    fallback: true,
                });
            }
        }

        res.json({ success: true, message: 'Verification email sent' });
    } catch (error) {
        console.error('[Email] Failed to send verification:', error.message);
        // Don't reveal whether email exists — prevent enumeration
        res.json({ success: true, message: 'If an account exists, a verification email has been sent' });
    }
});

/**
 * POST /api/auth/send-password-reset
 * Generates a password reset link and sends a custom branded email.
 * Body: { email: string }
 */
app.post('/api/auth/send-password-reset', authRateLimit, async (req, res) => {
    const { email } = req.body;
    if (!email) return sendError(res, 400, 'Email is required');

    try {
        // Get user record for display name (optional, don't fail if not found)
        let displayName = null;
        try {
            const userRecord = await admin.auth().getUserByEmail(email);
            displayName = userRecord.displayName;
        } catch (e) { /* user might not exist, still send to prevent enumeration */ }

        const actionCodeSettings = {
            url: 'https://claudec-839c6.web.app/__/auth/action',
            handleCodeInApp: false,
        };
        const resetLink = await admin.auth().generatePasswordResetLink(email, actionCodeSettings);

        await smtpTransporter.sendMail({
            from: '"ClaudeCredit" <pulsecreditverify@gmail.com>',
            to: email,
            subject: 'Reset your ClaudeCredit password 🔑',
            html: buildPasswordResetEmail(displayName, resetLink),
        });

        console.log(`[Email] Password reset email sent to ${maskEmail(email)}`);
        res.json({ success: true, message: 'Password reset email sent' });
    } catch (error) {
        console.error('[Email] Failed to send password reset:', error.message);
        // Don't reveal whether email exists (security)
        res.json({ success: true, message: 'If an account exists, a reset email has been sent' });
    }
});

// ─── Deep health check (checks dependencies) ───────────────────────────────
app.get('/api/health/deep', requireAuth, async (req, res) => {
    const checks = {};
    try {
        const dbStatus = await supabaseDb.healthCheck();
        checks.supabase = dbStatus;
    } catch (e) {
        checks.supabase = `error: ${e.message}`;
    }
    checks.plaid = process.env.PLAID_CLIENT_ID ? 'configured' : 'missing';
    checks.mx = isMxConfigured() ? 'configured' : 'missing';
    checks.ai = GEMINI_API_KEY ? 'gemini' : GROQ_API_KEY ? 'groq' : 'none';
    const allOk = checks.supabase === 'ok';
    res.status(allOk ? 200 : 503).json({ status: allOk ? 'healthy' : 'degraded', checks });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATA SYNC — iOS app syncs user data to/from Supabase via these endpoints
// ═══════════════════════════════════════════════════════════════════════════════

// Smart-refresh: token-derived sync ledger status + budget (preferred — avoids
// Firebase-UID/Supabase-UUID mismatch on the :userId variant below).
app.get('/api/sync/status', requireAuth, resolveSupabaseUser, syncHandlers.handleStatusFromToken);
// Smart-refresh: per-user sync ledger status + budget
app.get('/api/sync/status/:userId', requireAuth, resolveSupabaseUser, syncHandlers.handleStatus);
// Smart-refresh: force-refresh a single Plaid item (15-min floor + daily budget)
app.post('/api/sync/item/:itemId', requireAuth, resolveSupabaseUser, syncHandlers.handleItemSync);
// Smart-refresh: upsert APNs device token
app.post('/api/sync/register-device', requireAuth, resolveSupabaseUser, syncHandlers.handleRegisterDevice);

// Sync cards to Supabase
app.post('/api/sync/cards', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { cards } = req.body;
        if (!cards || !Array.isArray(cards)) {
            return sendError(res, 400, 'cards array is required');
        }
        await supabaseDb.syncCreditCards(req.supabaseUserId, cards);
        res.json({ synced: cards.length });
    } catch (error) {
        console.error('[Sync Error] Cards:', error.message);
        sendError(res, 500, 'Failed to sync cards');
    }
});

// Get cards from Supabase
app.get('/api/sync/cards', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const cards = await supabaseDb.getCreditCards(req.supabaseUserId);
        res.json({ cards: toCamelCase(cards) });
    } catch (error) {
        console.error('[Sync Error] Get cards:', error.message);
        sendError(res, 500, 'Failed to get cards');
    }
});

// Sync transactions to Supabase
app.post('/api/sync/transactions', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { transactions } = req.body; // { cardId: [transactions] }
        if (!transactions || typeof transactions !== 'object') {
            return sendError(res, 400, 'transactions object is required');
        }
        let total = 0;
        for (const [cardId, txns] of Object.entries(transactions)) {
            if (Array.isArray(txns) && txns.length > 0) {
                await supabaseDb.syncTransactions(req.supabaseUserId, cardId, txns);
                total += txns.length;
            }
        }
        res.json({ synced: total });
    } catch (error) {
        console.error('[Sync Error] Transactions:', error.message);
        sendError(res, 500, 'Failed to sync transactions');
    }
});

// Get transactions from Supabase
app.get('/api/sync/transactions', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const cardId = req.query.card_id || null;
        const txns = await supabaseDb.getTransactions(req.supabaseUserId, cardId);
        res.json({ transactions: toCamelCase(txns) });
    } catch (error) {
        console.error('[Sync Error] Get transactions:', error.message);
        sendError(res, 500, 'Failed to get transactions');
    }
});

// Sync bank accounts to Supabase
app.post('/api/sync/bank-accounts', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { accounts } = req.body;
        if (!accounts || !Array.isArray(accounts)) {
            return sendError(res, 400, 'accounts array is required');
        }
        await supabaseDb.syncBankAccounts(req.supabaseUserId, accounts);
        res.json({ synced: accounts.length });
    } catch (error) {
        console.error('[Sync Error] Bank accounts:', error.message);
        sendError(res, 500, 'Failed to sync bank accounts');
    }
});

// Get bank accounts from Supabase
app.get('/api/sync/bank-accounts', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accounts = await supabaseDb.getBankAccounts(req.supabaseUserId);
        res.json({ accounts: toCamelCase(accounts) });
    } catch (error) {
        console.error('[Sync Error] Get bank accounts:', error.message);
        sendError(res, 500, 'Failed to get bank accounts');
    }
});

// Sync bank transactions to Supabase
app.post('/api/sync/bank-transactions', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { transactions } = req.body; // { bankAccountId: [transactions] }
        if (!transactions || typeof transactions !== 'object') {
            return sendError(res, 400, 'transactions object is required');
        }
        let total = 0;
        for (const [accountId, txns] of Object.entries(transactions)) {
            if (Array.isArray(txns) && txns.length > 0) {
                await supabaseDb.syncBankTransactions(req.supabaseUserId, accountId, txns);
                total += txns.length;
            }
        }
        res.json({ synced: total });
    } catch (error) {
        console.error('[Sync Error] Bank transactions:', error.message);
        sendError(res, 500, 'Failed to sync bank transactions');
    }
});

// Get bank transactions from Supabase
app.get('/api/sync/bank-transactions', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const accountId = req.query.account_id || null;
        const txns = await supabaseDb.getBankTransactions(req.supabaseUserId, accountId);
        res.json({ transactions: toCamelCase(txns) });
    } catch (error) {
        console.error('[Sync Error] Get bank transactions:', error.message);
        sendError(res, 500, 'Failed to get bank transactions');
    }
});

// Get/update user preferences
app.get('/api/sync/preferences', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const prefs = await supabaseDb.getUserPreferences(req.supabaseUserId);
        res.json({ preferences: prefs });
    } catch (error) {
        console.error('[Sync Error] Get preferences:', error.message);
        sendError(res, 500, 'Failed to get preferences');
    }
});

app.post('/api/sync/preferences', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { preferences } = req.body;
        if (!preferences || typeof preferences !== 'object') {
            return sendError(res, 400, 'preferences object is required');
        }
        await supabaseDb.upsertUserPreferences(req.supabaseUserId, preferences);
        res.json({ success: true });
    } catch (error) {
        console.error('[Sync Error] Set preferences:', error.message);
        sendError(res, 500, 'Failed to set preferences');
    }
});

// Full data pull — gets everything for the user in one call
app.get('/api/sync/all', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const [cards, transactions, bankAccounts, bankTransactions, preferences] = await Promise.all([
            supabaseDb.getCreditCards(req.supabaseUserId),
            supabaseDb.getTransactions(req.supabaseUserId),
            supabaseDb.getBankAccounts(req.supabaseUserId),
            supabaseDb.getBankTransactions(req.supabaseUserId),
            supabaseDb.getUserPreferences(req.supabaseUserId),
        ]);
        res.json({
            cards: toCamelCase(cards),
            transactions: toCamelCase(transactions),
            bankAccounts: toCamelCase(bankAccounts),
            bankTransactions: toCamelCase(bankTransactions),
            preferences: toCamelCase(preferences),
        });
    } catch (error) {
        console.error('[Sync Error] Full pull:', error.message);
        sendError(res, 500, 'Failed to pull user data');
    }
});

// Budget sync
app.get('/api/sync/budgets', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const budgets = await supabaseDb.getBudgets(req.supabaseUserId);
        res.json({ budgets: toCamelCase(budgets) });
    } catch (error) {
        console.error('[Sync Error] Get budgets:', error.message);
        sendError(res, 500, 'Failed to fetch budgets');
    }
});

app.post('/api/sync/budgets', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { budgets } = req.body;
        if (!budgets || !Array.isArray(budgets)) {
            return sendError(res, 400, 'Missing budgets array');
        }
        await supabaseDb.syncBudgets(req.supabaseUserId, budgets);
        res.json({ synced: budgets.length });
    } catch (error) {
        console.error('[Sync Error] Save budgets:', error.message);
        sendError(res, 500, 'Failed to save budgets');
    }
});

// Goals sync
app.get('/api/sync/goals', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const goals = await supabaseDb.getGoals(req.supabaseUserId);
        res.json({ goals: toCamelCase(goals) });
    } catch (error) {
        console.error('[Sync Error] Get goals:', error.message);
        sendError(res, 500, 'Failed to fetch goals');
    }
});

app.post('/api/sync/goals', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        const { goals } = req.body;
        if (!goals || !Array.isArray(goals)) {
            return sendError(res, 400, 'Missing goals array');
        }
        await supabaseDb.syncGoals(req.supabaseUserId, goals);
        res.json({ synced: goals.length });
    } catch (error) {
        console.error('[Sync Error] Save goals:', error.message);
        sendError(res, 500, 'Failed to save goals');
    }
});

// Delete all user data
app.post('/api/sync/delete-all', requireAuth, resolveSupabaseUser, async (req, res) => {
    try {
        await supabaseDb.deleteAllUserData(req.supabaseUserId);
        res.json({ deleted: true });
    } catch (error) {
        console.error('[Sync Error] Delete all:', error.message);
        sendError(res, 500, 'Failed to delete user data');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

// 404 handler — don't echo the requested path (prevents route enumeration probing)
app.use((req, res) => {
    sendError(res, 404, 'Route not found');
});

// Global error handler - don't leak internal details to client
app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err);
    sendError(res, 500, 'Internal server error');
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Environment validation ─────────────────────────────────────────────────
const missingCritical = [];
if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    missingCritical.push('FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS (for auth)');
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    missingCritical.push('SUPABASE_SERVICE_ROLE_KEY (for database)');
}
if (!GEMINI_API_KEY && !GROQ_API_KEY) {
    missingCritical.push('GEMINI_API_KEY or GROQ_API_KEY (at least one AI provider)');
}
if (missingCritical.length > 0) {
    console.warn(`\n⚠️  Missing critical config:\n${missingCritical.map(m => `   - ${m}`).join('\n')}\n`);
}

// ─── Start server with graceful shutdown ────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                ClaudeCredit Server v4.1.0                   ║
╠══════════════════════════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(53)}║
║  Plaid Env: ${(process.env.PLAID_ENV || 'sandbox').padEnd(48)}║
║  Plaid: ${(process.env.PLAID_CLIENT_ID ? '✓ Configured' : '✗ Missing').padEnd(52)}║
║  MX: ${(isMxConfigured() ? '✓ Configured (' + MX_ENV + ')' : '✗ Not configured').padEnd(55)}║
║  AI (Gemini): ${(GEMINI_API_KEY ? '✓ Configured' : '✗ Missing — Groq fallback').padEnd(46)}║
║  AI (Groq):   ${(GROQ_API_KEY   ? '✓ Fallback ready' : '✗ Missing').padEnd(46)}║
║  Firebase Auth: ${(process.env.FIREBASE_SERVICE_ACCOUNT ? '✓ Configured' : '✗ Missing').padEnd(43)}║
║  SMTP Email:  ${(SMTP_CONFIGURED ? '✓ Configured' : '✗ Missing SMTP_PASS').padEnd(45)}║
║  Token Store: Supabase                                     ║
║  Supabase: ${(process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓ Configured' : '✗ Missing SUPABASE_SERVICE_ROLE_KEY').padEnd(49)}║
╠══════════════════════════════════════════════════════════════╣
║  Security: Auth middleware, rate limiting, CORS, Supabase   ║
╚══════════════════════════════════════════════════════════════╝
    `);
});

// Keep-alive timeout: prevent premature connection drops behind load balancers
server.keepAliveTimeout = 65000; // slightly above ALB's 60s default
server.headersTimeout = 66000;

// Graceful shutdown — Fly.io sends SIGTERM before killing containers
function gracefulShutdown(signal) {
    console.log(`\n[Server] ${signal} received — shutting down gracefully...`);
    server.close(() => {
        console.log('[Server] All connections drained. Exiting.');
        process.exit(0);
    });
    // Force exit after 10s if connections aren't draining
    setTimeout(() => {
        console.error('[Server] Forced exit after 10s timeout');
        process.exit(1);
    }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
