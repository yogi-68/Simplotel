# API examples

Every endpoint, with real captured responses. Base URL `http://localhost:4000`.

A Postman collection is in [`hotel-assistant.postman_collection.json`](./hotel-assistant.postman_collection.json)
— import it and set the `baseUrl` variable.

All responses carry an `X-Request-Id` header matching `requestId` in the body. Pass your own with
`-H 'X-Request-Id: my-trace-id'` and it is echoed back and attached to every log line for that turn.

---

## `GET /api/hotel`

Bootstrap data for the UI. No hotel details are hardcoded in the frontend.

```bash
curl -s http://localhost:4000/api/hotel
```

```jsonc
{
  "ok": true,
  "requestId": "34b25bd5-a0cd-4f3b-b9c5-5ea794f0da37",
  "hotel": {
    "name": "The Banyan Grove",
    "tagline": "A 48-room boutique retreat in the heart of Indiranagar",
    "city": "Bengaluru",
    "phone": "+91 80 4567 1200",
    "email": "stay@banyangrove.example",
    "checkInTime": "2:00 PM",
    "checkOutTime": "11:00 AM"
  },
  "roomTypes": [
    { "id": "garden-view-queen", "name": "Garden View Queen", "maxAdults": 2, "maxOccupancy": 2, "baseRate": 5800 },
    { "id": "deluxe-king",       "name": "Deluxe King",       "maxAdults": 2, "maxOccupancy": 3, "baseRate": 7400 },
    { "id": "executive-twin",    "name": "Executive Twin",    "maxAdults": 3, "maxOccupancy": 4, "baseRate": 8900 },
    { "id": "banyan-suite",      "name": "Banyan Suite",      "maxAdults": 4, "maxOccupancy": 5, "baseRate": 13500 }
  ],
  "suggestedQuestions": ["What time is check-in?", "Does the hotel have a swimming pool?", "..."]
}
```

---

## `POST /api/chat`

### 1. A grounded answer

```bash
curl -s -X POST http://localhost:4000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What time is check-in?"}'
```

```jsonc
{
  "ok": true,
  "requestId": "a5e4d6bf-ba94-4fc6-94af-048d731f77f4",
  "sessionId": "3f567cfe-62d9-4978-8cee-723f3c3637d4",
  "reply": { "text": "Check-in starts at 2:00 PM.", "type": "answer", "confidence": 0.91 },
  "sources": [
    { "id": "F26", "label": "Policies / Check-in time", "text": "Check-in starts at 2:00 PM." }
  ],
  "availability": null,
  "slots": { "checkIn": null, "checkOut": null, "adults": null, "children": null },
  "needs": [],
  "suggestions": ["Do you have rooms available next weekend?", "What is the cancellation policy?"],
  "meta": {
    "provider": "mock",
    "model": "deterministic-rules-v1",
    "latencyMs": 20,
    "toolCalls": [],
    "grounded": true,
    "degraded": false
  }
}
```

**Keep the `sessionId`** and send it on the next request to continue the conversation.

#### Response fields

| Field | Meaning |
|---|---|
| `reply.type` | `answer` · `availability` · `clarification` · `fallback` · `handoff` · `smalltalk` |
| `reply.confidence` | 0–1. Retrieval evidence blended with the model's self-report. |
| `sources` | Knowledge-base facts supporting the answer. Empty for a refusal, never fabricated. |
| `availability` | Structured engine output, or `null`. **Never parsed out of the reply text.** |
| `slots` | Stay details known so far, echoed so the UI form stays in sync. |
| `needs` | Which stay details are still missing — drives the inline booking form. |
| `meta.grounded` | `false` means a factual claim failed citation validation and was replaced. |
| `meta.degraded` | `true` means the model was unreachable and this came from the knowledge base. |

### 2. A follow-up

```bash
curl -s -X POST http://localhost:4000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"and checkout?","sessionId":"3f567cfe-62d9-4978-8cee-723f3c3637d4"}'
```

```jsonc
{
  "reply": { "text": "Check-out is at 11:00 AM.", "type": "answer", "confidence": 0.91 },
  "sources": [{ "id": "F27", "label": "Policies / Check-out time", "text": "Check-out is at 11:00 AM." }]
}
```

### 3. An honest refusal

```bash
curl -s -X POST http://localhost:4000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What time does the casino open?"}'
```

```jsonc
{
  "reply": {
    "text": "I do not have that information, so I would rather not guess. The front desk will be able to help you with it directly.",
    "type": "fallback",
    "confidence": 0.2
  },
  "sources": [],
  "suggestions": ["What time is check-in?", "Is breakfast included?"],
  "meta": { "grounded": true, "degraded": false }
}
```

> `grounded: true` on a refusal is correct — the flag means *no grounding rule was violated*. A
> refusal has nothing to cite, so it cannot violate one. It flips to `false` only when a factual
> answer was discarded for lacking valid citations.

### 4. Missing information — it asks rather than guesses

```bash
curl -s -X POST http://localhost:4000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Do you have rooms available?"}'
```

```jsonc
{
  "reply": {
    "text": "Happy to check that for you. Could you tell me your arrival date, your departure date and how many adults are staying?",
    "type": "clarification",
    "confidence": 0.9
  },
  "needs": ["checkIn", "checkOut", "adults"],
  "slots": { "checkIn": null, "checkOut": null, "adults": null, "children": null },
  "availability": null
}
```

No price is quoted, because no dates are known.

### 5. Availability via the tool

Supply `context` — this is what the booking form sends, and it outranks anything extracted from
language.

```bash
curl -s -X POST http://localhost:4000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "Do you have any rooms available?",
    "context": { "checkIn": "2026-10-16", "checkOut": "2026-10-18", "adults": 3 }
  }'
```

```jsonc
{
  "reply": {
    "text": "Good news, we have 1 option for your 2-night stay. The Executive Twin is the best value at INR 24,154 in total, including taxes and breakfast. Full details are in the cards below.",
    "type": "availability",
    "confidence": 0.95
  },
  "availability": { "...": "see POST /api/availability below for the full shape" },
  "slots": { "checkIn": "2026-10-16", "checkOut": "2026-10-18", "adults": 3, "children": 0 },
  "meta": { "toolCalls": ["check_availability"], "degraded": false }
}
```

---

## `POST /api/availability`

Deterministic. **No model is involved** — this is what the booking form posts to. The same query
always returns the same result.

```bash
curl -s -X POST http://localhost:4000/api/availability \
  -H 'Content-Type: application/json' \
  -d '{"checkIn":"2026-10-16","checkOut":"2026-10-18","adults":3}'
```

```jsonc
{
  "ok": true,
  "requestId": "4200f1a3-83eb-4ad2-bf67-7129d7e888b0",
  "availability": {
    "query": { "checkIn": "2026-10-16", "checkOut": "2026-10-18", "nights": 2, "adults": 3, "children": 0 },
    "available": true,
    "currency": "INR",
    "options": [
      {
        "roomTypeId": "executive-twin",
        "name": "Executive Twin",
        "description": "A 400 sq ft room with two double beds, built for three adults travelling together.",
        "maxAdults": 3,
        "maxOccupancy": 4,
        "bedding": "2 double beds",
        "sizeSqft": 400,
        "amenities": ["Two double beds", "Work desk", "Smart TV", "Mini-fridge", "Free Wi-Fi"],
        "roomsLeft": 3,
        "nightly": [
          { "date": "2026-10-16", "rate": 10235, "isWeekend": true,  "season": "standard" },
          { "date": "2026-10-17", "rate": 10235, "isWeekend": true,  "season": "standard" }
        ],
        "subtotal": 20470,
        "taxes": 3684,
        "total": 24154,
        "perNightAverage": 10235,
        "cancellationPolicy": "Free cancellation until 48 hours before 2:00 PM on the check-in date."
      }
    ],
    "excluded": [
      {
        "roomTypeId": "garden-view-queen",
        "name": "Garden View Queen",
        "reason": "occupancy",
        "explanation": "Sleeps up to 2 adults, so it cannot take a party of 3."
      },
      {
        "roomTypeId": "deluxe-king",
        "name": "Deluxe King",
        "reason": "occupancy",
        "explanation": "Sleeps up to 2 adults, so it cannot take a party of 3."
      },
      {
        "roomTypeId": "banyan-suite",
        "name": "Banyan Suite",
        "reason": "sold_out",
        "explanation": "Fully booked on Fri, 16 Oct 2026."
      }
    ],
    "notes": [
      "Buffet breakfast for all guests is included in every rate shown.",
      "Totals include GST, charged at 12% for nightly rates up to INR 7,500 and 18% above that."
    ]
  }
}
```

`excluded` is returned rather than silently dropped: a guest searching for three people needs to
know the Deluxe King exists and was ruled out on occupancy.

Optional fields: `children` (default `0`) and `roomTypeId` to narrow to one room type.

---

## `GET /api/health` and `/api/health/ready`

```bash
curl -s http://localhost:4000/api/health
# {"ok":true,"status":"up","uptimeSeconds":5}

curl -s http://localhost:4000/api/health/ready
```

```jsonc
{
  "ok": true,
  "requestId": "...",
  "checks": { "knowledgeBaseFacts": 47, "roomTypes": 4 },
  "config": { "provider": "mock", "model": "gpt-4o-mini", "retrievalMode": "lexical" }
}
```

Readiness also asserts the data loaded, so a deploy with a broken knowledge base fails the check
instead of quietly serving an assistant that knows nothing. The API key is never included.

---

## Error responses

Every failure uses the same envelope, so the client switches on `code` rather than parsing prose.

| Code | Status | Retryable | When |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | no | Bad input — the UI shows `details` inline |
| `NOT_FOUND` | 404 | no | Unknown route |
| `RATE_LIMITED` | 429 | yes | More than 30 chat requests/min per IP |
| `AI_TIMEOUT` / `AI_UNAVAILABLE` | 503 | yes | Model unreachable *after* the degraded path also failed |
| `INTERNAL_ERROR` | 500 | yes | Our bug. Never leaks internal detail. |

### Empty message

```bash
curl -s -X POST http://localhost:4000/api/chat \
  -H 'Content-Type: application/json' -d '{"message":""}'
```

```jsonc
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some details in your request were not valid.",
    "details": [{ "path": "message", "message": "Message cannot be empty" }],
    "requestId": "...",
    "retryable": false
  }
}
```

### Check-out before check-in

```bash
curl -s -X POST http://localhost:4000/api/availability \
  -H 'Content-Type: application/json' \
  -d '{"checkIn":"2026-10-18","checkOut":"2026-10-16","adults":2}'
```

```jsonc
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Check-out must be at least one night after check-in.",
    "details": [{ "path": "checkOut", "message": "Check-out must be at least one night after check-in." }],
    "retryable": false
  }
}
```

The **same broken rule on `/api/chat` is not a 400** — it comes back as a `clarification` asking the
guest to correct the dates. A conversational endpoint should ask; a form endpoint should reject.

### A date that is not real

```bash
curl -s -X POST http://localhost:4000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Any rooms?","context":{"checkIn":"2026-02-30"}}'
# details: [{ "path": "context.checkIn", "message": "Not a real calendar date" }]
```

### Unknown route

```bash
curl -s http://localhost:4000/api/nope
# { "ok": false, "error": { "code": "NOT_FOUND", "message": "No route for GET /api/nope", ... } }
```

---

## Testing the failure path

Start the server with the fault-injection provider:

```bash
cd apps/server && AI_PROVIDER=failing npx tsx src/index.ts
```

```bash
curl -s -X POST http://localhost:4000/api/chat \
  -H 'Content-Type: application/json' -d '{"message":"What time is check-in?"}'
```

```jsonc
{
  "ok": true,
  "reply": {
    "text": "Our assistant is temporarily unavailable, but here is what our records show. Check-in starts at 2:00 PM.",
    "type": "answer",
    "confidence": 0.5
  },
  "sources": [{ "id": "F26", "label": "Policies / Check-in time", "text": "Check-in starts at 2:00 PM." }],
  "meta": { "provider": "failing", "degraded": true }
}
```

**Status 200, with a real answer.** The knowledge base lives outside the model, so it is still
queryable when the model is gone.

Ask something the knowledge base does not cover while degraded and you get a handoff instead:

```bash
curl -s -X POST http://localhost:4000/api/chat \
  -H 'Content-Type: application/json' -d '{"message":"Do you have a helipad?"}'
# reply.type: "handoff", text includes the front desk number, meta.degraded: true
```
