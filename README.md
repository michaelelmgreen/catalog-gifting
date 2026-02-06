# Catalog Gifting — Minimal Gift Registry

Features implemented:
- Create a group with a primary group lead (first name, last name, email)
- Add/invite additional group members (simple in-memory invite)
- Browse products fetched from Shopify Catalog API (with mock fallback)
- Search and basic filtering (by title and product_type)
- Designate a recipient address and simulate checkout where transactional email uses a relay address

Quick start

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file with optional settings:

```
# Shopify Catalog API credentials from https://dev.shopify.com/dashboard
SHOPIFY_CATALOG_CLIENT_ID=your_client_id
SHOPIFY_CATALOG_CLIENT_SECRET=your_client_secret
RELAY_EMAIL=relay@example.com
PORT=3000
```

If `SHOPIFY_CATALOG_CLIENT_ID`/`SHOPIFY_CATALOG_CLIENT_SECRET` are not provided, the app uses mock products.

**How to get credentials:**
1. Go to [dev.shopify.com/dashboard](https://dev.shopify.com/dashboard)
2. Create an API key for the Catalog API
3. Copy the `client_id` and `client_secret` into your `.env` file

3. Run the app:

```bash
npm start
```

Open http://localhost:3000 in a mobile browser emulator.

Notes
- This is a minimal scaffold demonstrating the flows. No real payments or Shopify order creation is performed.
