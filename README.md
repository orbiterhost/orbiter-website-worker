## Orbiter.Website

This is a Cloudflare worker that is used for rendering Orbiter sites. The worker does the following: 

1. Accepts direct requests or proxied requests (when someone is using a custom domain)
2. Looks up the correct IPFS CID for the current version of the website
3. Loads the site through a [Pinata](https://pinata.cloud) Dedicated IPFS Gateway
4. Resolves all asset paths and html files

## Running locally

To run this project locally, you'll need to do the following: 

1. Clone the repository: `git clone https://github.com/orbiterhost/orbiter-website-worker.git`
2. Change into the directory: `cd orbiter-website-worker`
3. Install dependencies: `npm i`

Before you can run the worker locally or deploy it to your own Cloudflare instance, you will need to update the `wrangler.toml` file to include your own KV Bindings.

```
[[kv_namespaces]]
binding = "ORBITER_SITES"
id = ""

[[kv_namespaces]]
binding = "SITE_PLANS"
id = ""

[[kv_namespaces]]
binding = "SITE_TO_ORG"
id = ""

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = ""
```

The `ORBITER_SITE`, `SITE_PLANS`, and `SITE_TO_ORG` KV Binding IDs should be the same as the one you use with the `orbiter-backend` repository. The `RATE_LIMIT` binding will need to be created [following this guide](https://developers.cloudflare.com/kv/get-started/).

With all of this in place, you can run your worker with the following command: 

```
npm run dev
```