# Deployment

Two services: the API on **Render** and the web app on **Vercel**. They are deployed separately
because they want different things — the frontend wants a CDN and static hosting, the backend wants
a long-lived Node process holding conversation state and talking to the model.

Both have free tiers sufficient for a demo. You will need to do the logins yourself; everything
else is already configured in [`render.yaml`](../render.yaml) and [`vercel.json`](../vercel.json).

> **Order matters.** Deploy the API first — you need its URL to configure the web app, then you come
> back and give the API the web app's URL for CORS.

---

## 1. Push to GitHub

```bash
git remote add origin https://github.com/<you>/hotel-guest-assistant.git
git branch -M main
git push -u origin main
```

Confirm `.env` and `.env.local` are **not** in the push — they are gitignored, but check:

```bash
git ls-files | grep -E '\.env$|\.env\.local$'   # must print nothing
```

---

## 2. Deploy the API to Render

1. Go to **render.com** → **New** → **Blueprint**.
2. Connect the repository. Render reads `render.yaml` and proposes a service called
   `hotel-assistant-api`.
3. Click **Apply**. The first build takes 2–4 minutes.
4. Open the service → **Environment**, and set the two variables marked `sync: false`:

   | Variable | Value |
   |---|---|
   | `WEB_ORIGIN` | Leave blank for now — filled in at step 4 |
   | `OPENAI_API_KEY` | Your key, **only if** you want the real model |

5. If you set a key, also change `AI_PROVIDER` from `mock` to `openai` and **Save** (this
   redeploys). Without a key it runs the offline provider, which is a perfectly good demo.

Check it:

```bash
curl -s https://hotel-assistant-api.onrender.com/api/health
# {"ok":true,"status":"up",...}

curl -s https://hotel-assistant-api.onrender.com/api/health/ready
# checks.knowledgeBaseFacts should be 47
```

> **Free-tier cold starts.** Render spins the instance down after ~15 minutes idle, so the first
> request can take 30–50 seconds. The frontend's request timeout is 30s, so a cold first message may
> show the connection error and succeed on Retry. Hitting `/api/health` once to wake it before a
> demo avoids this. A paid instance removes it entirely.

---

## 3. Deploy the web app to Vercel

1. Go to **vercel.com** → **Add New** → **Project**, and import the same repository.
2. Vercel detects Next.js. Override these settings:

   | Setting | Value |
   |---|---|
   | Root Directory | **leave as the repo root** (not `apps/web` — npm workspaces need the root) |
   | Build Command | `npm run build --workspace apps/web` |
   | Output Directory | `apps/web/.next` |
   | Install Command | `npm install` |

3. Add an environment variable:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_BASE_URL` | `https://hotel-assistant-api.onrender.com` |

4. **Deploy.** Note the URL you get, e.g. `https://hotel-guest-assistant.vercel.app`.

---

## 4. Let the API accept the web app (CORS)

Back in Render → **Environment**, set:

| Variable | Value |
|---|---|
| `WEB_ORIGIN` | `https://hotel-guest-assistant.vercel.app` |

Save and let it redeploy. The allowlist is comma-separated if you need preview URLs too:

```
https://hotel-guest-assistant.vercel.app,https://hotel-guest-assistant-git-main-you.vercel.app
```

Vercel preview deployments get a fresh URL per branch, so either add them as you go or point
previews at a separate API instance.

---

## 5. Verify the deployment

Open the Vercel URL and walk the journey:

1. The header shows **The Banyan Grove** — if it says "Guest Assistant" and "Connecting…", the web
   app cannot reach the API. Check `NEXT_PUBLIC_API_BASE_URL` and `WEB_ORIGIN`.
2. Ask **"What time is check-in?"** — you should get the answer plus a source chip.
3. Ask **"and checkout?"** — confirms sessions survive across requests.
4. **Check availability** with any two dates — confirms the engine.
5. Ask **"What time does the casino open?"** — confirms the refusal path.

From the command line:

```bash
curl -s -X POST https://hotel-assistant-api.onrender.com/api/chat \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://hotel-guest-assistant.vercel.app' \
  -d '{"message":"What time is check-in?"}'
```

---

## Troubleshooting

**The UI says it cannot reach the hotel.** Either the API is cold (wait and Retry) or `WEB_ORIGIN`
does not exactly match the browser's origin. It must include the scheme and no trailing slash.

**Vercel build fails resolving `@hotel/contracts`.** The Root Directory is set to `apps/web`. Set it
back to the repository root — the workspace dependency only resolves from there.

**Render build fails on `npm ci`.** `package-lock.json` is out of date or missing. Run `npm install`
locally and commit the lockfile.

**Answers are robotic.** `AI_PROVIDER` is still `mock`. Set it to `openai` with a key.

**`Invalid server configuration: OPENAI_API_KEY is required`** in the Render logs. `AI_PROVIDER` is
`openai` but the key is unset. This is the boot-time validation doing its job — set the key or
switch back to `mock`.

---

## Alternative: one Docker host

If you would rather run both on one box, both apps build to standard Node artefacts:

```bash
npm ci
npm run build
node apps/server/dist/index.js          # API on $PORT
npm run start --workspace apps/web      # Next.js on 3000
```

Set `WEB_ORIGIN` and `NEXT_PUBLIC_API_BASE_URL` to match wherever they end up, and put a reverse
proxy in front.
