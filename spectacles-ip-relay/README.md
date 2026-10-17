# spectacles-ip-relay

Cloudflare Worker that maps a six-digit PIN to a private LAN IPv4 address. The Reachy Mini app and ARModule publish; a Spectacles Lens looks the PIN up, then opens its existing local WebSocket.

`POST /v1/pins` with `{ "ip", "port" }` returns `{ "pin", "key", "ttlSeconds" }`. `PUT` and `DELETE /v1/pins/{pin}` send `Authorization: Bearer <key>`. `GET /v1/pins/{pin}` returns `{ "ip", "port" }` or 404. Records last 120 seconds.

## Deploy

```bash
cd spectacles-ip-relay
npm install
npx wrangler login
npx wrangler deploy
./smoke.sh https://spectacles-ip-relay.johannestscharn.workers.dev
```

The deployed URL is `https://spectacles-ip-relay.johannestscharn.workers.dev`. It is `IP_RELAY_URL` in each app that publishes or resolves a PIN.
