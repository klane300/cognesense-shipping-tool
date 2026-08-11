# Cognesense Shipping Quote Tool

A single-page shipping quote dashboard (`index.html`) with an optional live-rates
backend (`api/quote.js`) that calls EasyPost. The dashboard works standalone
with a built-in estimate engine even without the backend — the backend just
upgrades it to real carrier rates.

## Why there's a backend at all

`index.html` runs entirely in the browser. It can never hold your EasyPost API
key directly — anyone who opens the page (view source, or the browser's
network tab) would be able to see it and make calls against your account.
`api/quote.js` is a small serverless function that holds the key instead: the
frontend calls `/api/quote` with the shipment details, and the function calls
EasyPost on your behalf, server-side, and returns just the rates.

## Deploying to Vercel (free tier)

You need a [Vercel](https://vercel.com) account (free) and, if you don't
already have one, an [EasyPost](https://www.easypost.com) account with an API
key (Dashboard -> API Keys). You already have both.

**Option A — Vercel CLI (fastest)**

1. Install the CLI once: `npm install -g vercel`
2. From inside this folder, run: `vercel`
   - Follow the prompts (log in, link/create a project, accept defaults).
   - This creates a preview deployment.
3. Add your API key as an environment variable — **do this in the Vercel
   dashboard, not in any file**:
   - Go to your project on vercel.com -> Settings -> Environment Variables.
   - Add a variable named `EASYPOST_API_KEY`, value = your real EasyPost key.
   - Apply it to Production (and Preview, if you want to test there too).
4. Deploy to production: `vercel --prod`
5. Open the URL Vercel gives you. In the dashboard, check "Use live EasyPost
   rates" and request a quote.

**Option B — Vercel dashboard (no CLI)**

1. Push this folder to a new GitHub repo (or any git provider Vercel supports).
2. On vercel.com, click "Add New -> Project" and import that repo.
3. Before or after the first deploy, go to Settings -> Environment Variables
   and add `EASYPOST_API_KEY` with your real key.
4. Redeploy (Vercel dashboard has a "Redeploy" button) so the function picks
   up the new environment variable.

## Testing locally (optional)

```
npm install -g vercel
vercel dev
```

`vercel dev` runs both the static `index.html` and the `/api/quote` function
locally, reading environment variables from a local `.env` file if you create
one (copy `.env.example` to `.env` and fill in your key — this file is
git-ignored and never leaves your machine).

## How rates are combined across multiple packages

EasyPost rates one parcel per request. If your quote has more than one
package, `api/quote.js` requests rates for each package separately, then adds
together the price for any carrier + service that was offered for **every**
package in the shipment. A service that isn't available for one of the boxes
(too large, too heavy, etc.) is dropped from the combined list rather than
silently under-quoting the total — so a shorter combined list can mean one of
your packages doesn't qualify for that service, not that something broke.

## Turning live mode back off

The "Use live EasyPost rates" toggle in the dashboard is per-visit and starts
off. With it off, the page works exactly as before with no network calls and
no dependency on this backend — useful if the API key runs out of quota, the
function is down, or you just want a fast ballpark.
