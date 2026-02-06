const express = require('express');
const https = require('https');
const fs = require('fs');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// In-memory stores (for demo only)
const groups = {};
let nextGroupId = 1;

const MOCK_PRODUCTS = [
  { id: '1', title: 'Wireless Headphones', product_type: 'Electronics', price: 99.99 },
  { id: '2', title: 'Ceramic Coffee Mug', product_type: 'Home', price: 19.99 },
  { id: '3', title: 'Standing Desk Lamp', product_type: 'Home', price: 49.5 }
];

// ---------------------------------------------------------------------------
// Shopify Catalog API helpers
// ---------------------------------------------------------------------------
const CATALOG_AUTH_URL = 'https://api.shopify.com/auth/access_token';
const CATALOG_SEARCH_URL = 'https://discover.shopifyapps.com/global/v2/search';

let catalogToken = null;
let catalogTokenExpiry = 0;

async function getCatalogToken() {
  const clientId = process.env.SHOPIFY_CATALOG_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CATALOG_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Re-use token if still valid (with 60s buffer)
  if (catalogToken && Date.now() < catalogTokenExpiry - 60000) {
    return catalogToken;
  }

  const r = await fetch(CATALOG_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' })
  });
  const body = await r.json();
  if (body && body.access_token) {
    catalogToken = body.access_token;
    catalogTokenExpiry = Date.now() + (body.expires_in || 3600) * 1000;
    return catalogToken;
  }
  throw new Error('Failed to obtain Catalog API token');
}

async function searchCatalog(query, options = {}) {
  const token = await getCatalogToken();
  if (!token) return null;

  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (options.limit) params.set('limit', options.limit);
  if (options.categories) params.set('categories', options.categories);

  const url = `${CATALOG_SEARCH_URL}?${params.toString()}`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return r.json();
}

// ---------------------------------------------------------------------------
// UCP Agent Profile – serves the agent profile JSON that Shopify UCP needs
// to negotiate the checkout session. Hosted at /profiles/gift-agent.json
// ---------------------------------------------------------------------------
app.get('/profiles/gift-agent.json', (req, res) => {
  res.json({
    name: 'Catalog Gifting Agent',
    description: 'A gift registry agent that coordinates group purchases with recipient shipping addresses.',
    version: '1.0.0',
    ucp: {
      version: '2026-01-11',
      capabilities: {
        'dev.ucp.shopping.checkout': [{ version: '2026-01-11' }],
        'dev.ucp.shopping.fulfillment': [{ version: '2026-01-11' }]
      },
      delegations: ['fulfillment.address_change']
    }
  });
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Config endpoint — serves public API keys to the frontend
app.get('/api/config', (req, res) => {
  res.json({
    googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || ''
  });
});

// Products endpoint: proxy to Shopify Catalog API or return mock
app.get('/api/products', async (req, res) => {
  const q = (req.query.q || '').trim();
  const filter = (req.query.filter || '').trim(); // e.g. category id

  // Attempt to use Shopify Catalog API when credentials are configured
  if (process.env.SHOPIFY_CATALOG_CLIENT_ID && process.env.SHOPIFY_CATALOG_CLIENT_SECRET) {
    try {
      const searchQuery = [q, filter].filter(Boolean).join(' ');
      console.log('Fetching from Catalog API with query:', searchQuery || 'gift');
      const body = await searchCatalog(searchQuery || 'gift', { limit: 10 });
      console.log('Catalog API response type:', Array.isArray(body) ? 'array' : typeof body, 'length:', body?.length);

      // Catalog API returns an array of products directly
      if (body && Array.isArray(body)) {
        const products = body.map(p => {
          // Extract the shop domain from variant URL for UCP/MCP checkout
          const varUrl = p.variants?.[0]?.checkoutUrl || p.variants?.[0]?.variantUrl || '';
          const domainMatch = varUrl.match(/^https?:\/\/([^/]+)/);
          const shopDomain = domainMatch ? domainMatch[1] : null;

          return {
            id: p.id,
            title: p.title,
            description: p.description,
            product_type: p.techSpecs?.find(s => s.includes('Category'))?.replace('Category: ', '') || '',
            price: p.priceRange?.min?.amount ? (p.priceRange.min.amount / 100).toFixed(2) : null,
            currency: p.priceRange?.min?.currency || 'USD',
            image: p.media?.[0]?.url || null,
            merchant: p.variants?.[0]?.shop?.name || null,
            shopDomain,  // e.g. "happyhyggegifts.com" – needed for UCP/MCP checkout
            rating: p.rating?.rating || null,
            reviewCount: p.rating?.count || 0,
            checkoutUrl: p.variants?.[0]?.checkoutUrl || null,
            variantUrl: p.variants?.[0]?.variantUrl || null,
            variantId: p.variants?.[0]?.id || null
          };
        });
        return res.json({ products, source: 'shopify_catalog_api' });
      } else {
        console.log('Unexpected response format:', JSON.stringify(body).slice(0, 200));
      }
    } catch (err) {
      console.error('Shopify Catalog API fetch failed, falling back to mock:', err && err.message);
    }
  } else {
    console.log('Catalog API credentials not configured');
  }

  // Fallback: mock behavior if Catalog API not configured or fetch fails
  let results = MOCK_PRODUCTS.slice();
  if (q) results = results.filter(p => p.title.toLowerCase().includes(q.toLowerCase()));
  if (filter) results = results.filter(p => (p.product_type || '').toLowerCase() === filter.toLowerCase());
  res.json({ products: results, source: 'mock' });
});

// Create a group (group lead)
app.post('/api/groups', (req, res) => {
  const { firstName, lastName, email, phone } = req.body;
  if (!firstName || !lastName || !email) return res.status(400).json({ error: 'Missing lead info' });
  const id = String(nextGroupId++);
  // Group lead is also the first member with isLead flag
  const leadMember = { id: '1', firstName, lastName, email, phone, isLead: true };
  groups[id] = { id, lead: { firstName, lastName, email, phone }, members: [leadMember], recipient: null };
  res.json({ group: groups[id] });
});

// Add/invite member
app.post('/api/groups/:id/members', (req, res) => {
  const group = groups[req.params.id];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { firstName, lastName, email, phone } = req.body;
  if (!email) return res.status(400).json({ error: 'Member email required' });
  const member = { id: `${group.members.length + 1}`, firstName, lastName, email, phone };
  group.members.push(member);
  res.json({ member });
});

// Set recipient address
app.post('/api/groups/:id/recipient', (req, res) => {
  const group = groups[req.params.id];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { firstName, lastName, phone, address1, address2, city, state, provinceCode, postalCode, country } = req.body;
  group.recipient = { firstName, lastName, phone, address1, address2, city, state, provinceCode, postalCode, country };
  res.json({ recipient: group.recipient });
});

// ---------------------------------------------------------------------------
// Create checkout via Shopify UCP/MCP
// POST https://{shopDomain}/api/ucp/mcp  (JSON-RPC 2.0)
// ---------------------------------------------------------------------------
app.post('/api/create-checkout', async (req, res) => {
  const { groupId, variantId, quantity, shopDomain } = req.body;
  const group = groups[groupId];

  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.recipient) return res.status(400).json({ error: 'Recipient not set' });
  if (!variantId) return res.status(400).json({ error: 'Variant ID required' });
  if (!shopDomain) return res.status(400).json({ error: 'Shop domain required' });

  // Get the Catalog API bearer token
  let token;
  try {
    token = await getCatalogToken();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get auth token: ' + err.message });
  }

  // Strip any query params from variantId (e.g. "?shop=12345")
  const cleanVariantId = variantId.split('?')[0];

  // Build the JSON-RPC request per UCP/MCP spec
  const jsonRpcBody = {
    jsonrpc: '2.0',
    method: 'tools/call',
    id: 1,
    params: {
      name: 'create_checkout',
      arguments: {
        meta: {
          'ucp-agent': {
            profile: process.env.AGENT_PROFILE_URL || `http://localhost:${PORT}/profiles/gift-agent.json`
          }
        },
        checkout: {
          idempotency_key: uuidv4(),
          currency: 'USD',
          line_items: [
            {
              quantity: quantity || 1,
              item: { id: cleanVariantId }
            }
          ],
          buyer: {
            email: group.lead.email,   // Lead gets order emails → surprise preserved
            phone_number: group.recipient.phone || ''
          },
          fulfillment: {
            methods: [
              {
                type: 'shipping',
                destinations: [
                  {
                    first_name: group.recipient.firstName,
                    last_name: group.recipient.lastName,
                    phone_number: group.recipient.phone || '',
                    street_address: group.recipient.address1,
                    address_locality: group.recipient.city,
                    address_region: group.recipient.provinceCode || group.recipient.state,
                    postal_code: group.recipient.postalCode,
                    address_country: group.recipient.country === 'United States' ? 'US' :
                                     group.recipient.country === 'Canada' ? 'CA' : 'US'
                  }
                ]
              }
            ]
          }
        }
      }
    }
  };

  const ucpUrl = `https://${shopDomain}/api/ucp/mcp`;
  console.log('[UCP] POST', ucpUrl);
  console.log('[UCP] Body:', JSON.stringify(jsonRpcBody, null, 2));

  try {
    const ucpRes = await fetch(ucpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(jsonRpcBody)
    });

    const data = await ucpRes.json();
    console.log('[UCP] Response:', JSON.stringify(data, null, 2));

    // Parse the result – MCP returns { result: { content: [{ text: "..." }] } }
    let checkout = data;
    if (data.result?.content?.[0]?.text) {
      const textContent = data.result.content[0].text;
      try { checkout = JSON.parse(textContent); } catch (_) { checkout = textContent; }
    } else if (data.error) {
      // UCP/MCP returned a JSON-RPC error – surface it with detail
      const errDataStr = data.error.data
        ? (typeof data.error.data === 'string' ? data.error.data : JSON.stringify(data.error.data))
        : '';
      const errDetail = errDataStr ? ` – ${errDataStr}` : '';
      const isAccessDisabled = (typeof data.error.data === 'string' && data.error.data === 'Access disabled.')
        || (typeof data.error.data === 'object' && data.error.data?.code === 'ACCESS_DISABLED');
      throw {
        message: data.error.message + errDetail,
        code: data.error.code,
        ucpError: data.error,
        accessDisabled: isAccessDisabled
      };
    }

    const continueUrl = checkout?.continue_url || checkout?.checkoutUrl || checkout?.web_url || null;

    res.json({
      success: true,
      checkoutUrl: continueUrl,
      checkoutId: checkout?.id || null,
      status: checkout?.status || null,
      messages: checkout?.messages || [],
      mcpResponse: checkout,
      requestPayload: jsonRpcBody.params.arguments,
      ucpEndpoint: ucpUrl,
      groupInfo: {
        leadEmail: group.lead.email,
        recipientName: `${group.recipient.firstName} ${group.recipient.lastName}`,
        recipientAddress: `${group.recipient.address1}, ${group.recipient.city}, ${group.recipient.state} ${group.recipient.postalCode}`
      }
    });
  } catch (err) {
    console.error('[UCP] Error:', err);

    res.status(500).json({
      success: false,
      error: typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err),
      requestPayload: jsonRpcBody.params.arguments,
      ucpEndpoint: ucpUrl,
      groupInfo: {
        leadEmail: group.lead.email,
        recipientName: `${group.recipient.firstName} ${group.recipient.lastName}`,
        recipientAddress: `${group.recipient.address1}, ${group.recipient.city}, ${group.recipient.state} ${group.recipient.postalCode}`
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Tokenize credit card via Shopify Card Server
// POST https://checkout.pci.shopifyinc.com/sessions
// ---------------------------------------------------------------------------
app.post('/api/tokenize-card', async (req, res) => {
  const { cardNumber, name, month, year, cvv, shopDomain } = req.body;

  if (!cardNumber || !name || !month || !year || !cvv) {
    return res.status(400).json({ error: 'All card fields are required' });
  }

  try {
    const cardServerUrl = 'https://checkout.pci.shopifyinc.com/sessions';
    console.log('[CardServer] Tokenizing card for', shopDomain);

    const tokenRes = await fetch(cardServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credit_card: {
          number: cardNumber.replace(/\s/g, ''),
          name,
          month: parseInt(month),
          year: parseInt(year),
          verification_value: cvv,
          start_month: null,
          start_year: null,
          issue_number: ''
        },
        payment_session_scope: `https://${shopDomain}`
      })
    });

    const data = await tokenRes.json();
    console.log('[CardServer] Response:', JSON.stringify(data, null, 2));

    if (data.id) {
      res.json({ success: true, sessionToken: data.id });
    } else {
      res.status(400).json({ success: false, error: data.error || 'Card tokenization failed', raw: data });
    }
  } catch (err) {
    console.error('[CardServer] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Complete checkout via Shopify UCP/MCP
// POST https://{shopDomain}/api/ucp/mcp  (JSON-RPC 2.0)
// Uses the dev.shopify.card payment handler with a tokenized card
// ---------------------------------------------------------------------------
app.post('/api/complete-checkout', async (req, res) => {
  const { checkoutId, sessionToken, billingAddress, shopDomain } = req.body;

  if (!checkoutId || !sessionToken || !shopDomain) {
    return res.status(400).json({ error: 'checkoutId, sessionToken, and shopDomain are required' });
  }

  let token;
  try {
    token = await getCatalogToken();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get auth token: ' + err.message });
  }

  const billing = billingAddress || {};
  const jsonRpcBody = {
    jsonrpc: '2.0',
    method: 'tools/call',
    id: 2,
    params: {
      name: 'complete_checkout',
      arguments: {
        meta: {
          'idempotency-key': uuidv4(),
          'ucp-agent': {
            profile: process.env.AGENT_PROFILE_URL || `http://localhost:${PORT}/profiles/gift-agent.json`
          }
        },
        id: checkoutId,
        payment: {
          instruments: [
            {
              id: 'instrument_1',
              handler_id: 'shopify.card',
              type: 'card',
              selected: true,
              credential: {
                type: 'shopify_token',
                token: sessionToken
              },
              billing_address: {
                first_name: billing.firstName || '',
                last_name: billing.lastName || '',
                phone_number: billing.phone || '',
                street_address: billing.address1 || '',
                address_locality: billing.city || '',
                address_region: billing.state || '',
                postal_code: billing.postalCode || '',
                address_country: billing.country || 'US'
              }
            }
          ]
        }
      }
    }
  };

  const ucpUrl = `https://${shopDomain}/api/ucp/mcp`;
  console.log('[UCP] Complete checkout POST', ucpUrl);
  console.log('[UCP] Body:', JSON.stringify(jsonRpcBody, null, 2));

  try {
    const ucpRes = await fetch(ucpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(jsonRpcBody)
    });

    const data = await ucpRes.json();
    console.log('[UCP] Complete response:', JSON.stringify(data, null, 2));

    let result = data;
    if (data.result?.content?.[0]?.text) {
      try { result = JSON.parse(data.result.content[0].text); } catch (_) { result = data.result.content[0].text; }
    } else if (data.error) {
      const errDataStr = data.error.data
        ? (typeof data.error.data === 'string' ? data.error.data : JSON.stringify(data.error.data))
        : '';
      throw { message: data.error.message + (errDataStr ? ` – ${errDataStr}` : '') };
    }

    res.json({
      success: true,
      status: result?.status || null,
      orderId: result?.order?.id || null,
      messages: result?.messages || [],
      mcpResponse: result
    });
  } catch (err) {
    console.error('[UCP] Complete error:', err);
    res.status(500).json({
      success: false,
      error: typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err)
    });
  }
});

// ---------------------------------------------------------------------------
// Build Embedded Checkout URL (ECP)
// Takes a continue_url from a requires_escalation response, appends
// ec_version, ec_auth (Catalog API JWT), and ec_delegate params.
// ---------------------------------------------------------------------------
app.post('/api/embedded-checkout-url', async (req, res) => {
  const { continue_url } = req.body;

  if (!continue_url) {
    return res.status(400).json({ error: 'continue_url is required' });
  }

  try {
    const token = await getCatalogToken();
    const checkoutURL = new URL(continue_url);

    // ECP query params per https://ucp.dev/specification/embedded-checkout/
    checkoutURL.searchParams.set('ec_version', '2026-01-11');
    checkoutURL.searchParams.set('ec_auth', token);
    // Delegate fulfillment address — checkout will fire
    // ec.fulfillment.address_change_request which the host responds to.
    // Payment is NOT delegated; the embedded checkout handles it.
    checkoutURL.searchParams.set('ec_delegate', 'fulfillment.address_change');
    // Skip Shop Pay redirect — without this the continue_url redirects
    // through shop.app which requires an active Shop Pay session,
    // causing a redirect loop that ends at the shop homepage.
    checkoutURL.searchParams.set('skip_shop_pay', 'true');

    console.log('[ECP] Built embedded URL:', checkoutURL.toString());
    res.json({ embedded_url: checkoutURL.toString() });
  } catch (err) {
    console.error('[ECP] Error building URL:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:id', (req, res) => {
  const group = groups[req.params.id];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json({ group });
});

// ---------------------------------------------------------------------------
// Start HTTPS server (self-signed cert for local dev).
// Shopify checkout CSP requires the host to be HTTPS for iframe embedding.
// On first visit, accept the self-signed cert warning in your browser.
// ---------------------------------------------------------------------------
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
};

https.createServer(sslOptions, app).listen(PORT, () => {
  console.log(`🔒 HTTPS server running on https://localhost:${PORT}`);
});
