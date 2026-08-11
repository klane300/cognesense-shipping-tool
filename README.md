# Cognesense Shipping Quote Tool

A single-page shipping quote dashboard (`index.html`) with two optional live-rates
backends: `api/quote.js` (small parcel, via EasyPost) and `api/freight-quote.js`
(freight/LTL pallets, via Warp). The dashboard works standalone with built-in
estimate engines for both shipment types even without either backend — the
backends just upgrade it to real carrier/LTL rates.

## Why there's a backend at all

`index.html` runs entirely in the browser. It can never hold your EasyPost or
Warp API keys directly — anyone who opens the page (view source, or the
browser's network tab) would be able to see them and make calls against your
account. `api/quote.js` and `api/freight-quote.js` are small serverless
functions that hold the keys instead: the frontend calls `/api/quote` or
`/api/freight-quote` with the shipment details, and the function calls
EasyPost/Warp on your behalf, server-side, and returns just the rate.

Note: Warp's quote endpoint is actually keyless (it works without a key at a
lower rate limit), but `api/freight-quote.js` still holds `WARP_API_KEY`
server-side for the same reason — it's never exposed to the browser, and it
raises your rate limit substantially.

## Deploying to Vercel (free tier)

You need a [Vercel](https://vercel.com) account (free), an
[EasyPost](https://www.easypost.com) account with an API key (Dashboard ->
API Keys) for small-parcel rates, and a [Warp](https://www.wearewarp.com)
account with an API key (`/agents/account`, instant, no card required) for
freight/LTL rates. You only need whichever of the two you plan to use live —
either backend works independently, and both dashboards fall back to the
built-in estimate if its key isn't set.

**Note: there is nothing to `npm install` inside this project.**
Both API functions have zero dependencies — they only use `fetch` and
`Buffer`, which are built into the Node.js runtime Vercel already provides.
That's why `package.json` has no `dependencies` list and there's no
`node_modules` folder in this zip. The only thing you install is the Vercel
CLI itself (step 1 below), and that installs *globally* onto your computer as
a command you can run from anywhere — it's not a file that belongs in this
folder.

**Option A — Vercel CLI (fastest)**

1. Install the CLI once, if you don't already have the `vercel` command:
   `npm install -g vercel`
2. From inside this folder, run: `vercel`
   - Follow the prompts (log in, link/create a project, accept defaults).
   - This creates a preview deployment.
3. Add your API key(s) as environment variables — **do this in the Vercel
   dashboard, not in any file**:
   - Go to your project on vercel.com -> Settings -> Environment Variables.
   - Add `EASYPOST_API_KEY` (your real EasyPost key) for live parcel rates.
   - Add `WARP_API_KEY` (your real Warp key, `wak_test_...` or
     `wak_live_...`) for live freight/LTL rates.
   - Apply each to Production (and Preview, if you want to test there too).
4. Deploy to production: `vercel --prod`
5. Open the URL Vercel gives you. Check "Use live EasyPost rates" (parcel) or
   switch Shipment type to Freight/LTL and check "Use live Warp freight
   rates," then request a quote.

**Option B — Vercel dashboard (no CLI)**

1. Push this folder to a new GitHub repo (or any git provider Vercel supports).
2. On vercel.com, click "Add New -> Project" and import that repo.
3. Before or after the first deploy, go to Settings -> Environment Variables
   and add `EASYPOST_API_KEY` and/or `WARP_API_KEY` with your real keys.
4. Redeploy (Vercel dashboard has a "Redeploy" button) so the functions pick
   up the new environment variables.

## Testing locally (optional)

```
npm install -g vercel   # skip if you already ran this in step 1 above
vercel dev
```

`vercel dev` runs the static `index.html` and both `/api/quote` and
`/api/freight-quote` functions locally, reading environment variables from a
local `.env` file if you create one (copy `.env.example` to `.env` and fill
in your key(s) — this file is git-ignored and never leaves your machine).

## How rates are combined across multiple packages

EasyPost rates one parcel per request. If your quote has more than one
package, `api/quote.js` requests rates for each package separately, then adds
together the price for any carrier + service that was offered for **every**
package in the shipment. A service that isn't available for one of the boxes
(too large, too heavy, etc.) is dropped from the combined list rather than
silently under-quoting the total — so a shorter combined list can mean one of
your packages doesn't qualify for that service, not that something broke.

Freight/LTL works differently: Warp prices the whole multi-pallet shipment
together in a single request (`api/freight-quote.js` sends every pallet as one
`items` array), matching how LTL carriers actually quote — there's no
per-package summing to worry about there.

## About the Warp freight/LTL integration

This is newer and less battle-tested than the EasyPost integration. Warp's
`/ltl/quote` endpoint is keyless and free to call — `api/freight-quote.js`
works even with `WARP_API_KEY` unset, just at a lower rate limit. A few
accessorial mappings (e.g. "Inside delivery" in the dashboard's Freight
details card) aren't sent to Warp because the exact field name wasn't
confirmed in the available docs — that checkbox currently only affects the
built-in estimate, not the live quote. If a live quote comes back with an
error mentioning a specific field, that's the signal to adjust the mapping in
`fetchFreightLiveRates()` (in `index.html`) and the corresponding spot in
`api/freight-quote.js`.

## Turning live mode back off

The "Use live EasyPost rates" and "Use live Warp freight rates" toggles in the
dashboard are per-visit and start off. With either off, that part of the page
works exactly as before with no network calls and no dependency on its
backend — useful if an API key runs out of quota, a function is down, or you
just want a fast ballpark.
