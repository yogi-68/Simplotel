# Architecture

## The shape of it

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BROWSER — Next.js 15 / React 19          http://localhost:3000          │
│                                                                          │
│   ChatShell ── useChat (reducer state machine) ── lib/api.ts             │
│      │                                              │                    │
│      ├── MessageBubble + typewriter                 │ fetch, timeout,    │
│      ├── SourceChips   (tap to see the evidence)    │ typed errors       │
│      ├── AvailabilityCard (renders engine output)   │                    │
│      └── BookingForm   (dates + party size)         │                    │
│                                                     │                    │
│   No API key. No model call. One base URL.          │                    │
└─────────────────────────────────────────────────────┼────────────────────┘
                                                      │ HTTPS / JSON
                              ┌───────────────────────▼────────────────────┐
                              │  API — Express 5 / TypeScript   :4000      │
                              │                                            │
                              │  helmet · CORS · rate limit · requestId    │
                              │  zod validation · error handler            │
                              │                                            │
                              │  ┌──────────────────────────────────────┐  │
                              │  │  orchestrator/assistant.service.ts   │  │
                              │  │                                      │  │
                              │  │  1 retrieve (BM25 + synonyms)        │  │
                              │  │  2 build prompt (facts + slots)      │  │
                              │  │  3 call model ──────────────┐        │  │
                              │  │  4 validate tool args       │        │  │
                              │  │  5 run availability engine  │        │  │
                              │  │  6 model narrates result ◄──┘        │  │
                              │  │  7 parse + schema check              │  │
                              │  │  8 VALIDATE CITATIONS                │  │
                              │  │  9 envelope                          │  │
                              │  └───────┬──────────────────┬───────────┘  │
                              │          │                  │              │
                              │   ┌──────▼──────┐   ┌───────▼───────────┐  │
                              │   │ knowledge/  │   │ availability/     │  │
                              │   │ 47 facts    │   │ 4 room types      │  │
                              │   │ BM25 index  │   │ seeded inventory  │  │
                              │   │             │   │ pricing + GST     │  │
                              │   └─────────────┘   └───────────────────┘  │
                              │          │                                 │
                              │   ┌──────▼────────────────────────────┐    │
                              │   │ ai/  LlmProvider interface        │    │
                              │   │  ├── openai.provider  (real)      │    │
                              │   │  ├── mock.provider    (offline)   │    │
                              │   │  └── failing.provider (injection) │    │
                              │   │  wrapped in timeout/retry/breaker │    │
                              │   └──────┬────────────────────────────┘    │
                              └──────────┼─────────────────────────────────┘
                                         │  only when AI_PROVIDER=openai
                                    ┌────▼─────┐
                                    │  OpenAI  │
                                    └──────────┘
```

`packages/contracts` sits beside both: one set of zod schemas defining every request and response,
imported by the server for validation and by the web app for types. The API shape cannot drift
between the two because there is only one definition of it.

---

## The turn pipeline

A single `POST /api/chat` goes through nine steps. The ordering is the design.

**1. Retrieve.** BM25 over 47 atomic knowledge-base facts, with query-side synonym expansion and
bigram joining. Returns the top 8 facts, a `confidence` (IDF-weighted coverage of the question's
distinctive words against the corpus) and a `strength` (how strongly the best fact matched).

If the message is short and retrieved nothing, we retry with the previous guest turn appended —
but only if every word in it is already known to the corpus. That fence exists because without it,
"what time does the casino open?" borrowed vocabulary from the previous turn, cleared the context
floor, and got confidently answered about something else.

**2. Build the prompt.** Hotel identity, grounding rules, the retrieved facts as `[F26] Check-in
starts at 2:00 PM.`, stay details carried from earlier turns, today's date, and one tool
definition. When retrieval found nothing, a `NO RELEVANT KNOWLEDGE FOUND` marker replaces the fact
block and the model's only legal moves become refuse, clarify or greet.

**3. Call the model.** Structured output (`json_schema`, strict) so the reply is a typed object
rather than prose, at `temperature: 0.2`.

**4. Validate tool arguments.** `check_availability` arguments are produced by a language model, so
they are treated exactly like untrusted HTTP input: zod for shape, then business rules for meaning
(check-in not in the past, check-out after check-in, at most 30 nights, 1–8 adults). A broken rule
becomes a structured tool error, not an exception.

**5. Run the engine.** A pure function over room types, a seeded PRNG for per-date inventory, and
real pricing: weekend uplift, seasonal multipliers, minimum stays, and India's slab-based GST
computed per night rather than on the booking total.

**6. Narrate.** The model receives a *compacted* result — totals and counts, not every nightly
rate. It writes one sentence around the numbers; it never produces them. The full structured object
goes to the UI separately.

**7. Parse.** The reply is validated against the zod schema. Malformed output becomes a fallback,
never a crash.

**8. Validate citations.** Every `sourceId` the model returned must exist among the facts retrieved
*this turn*. A reply of type `answer` with no valid citation is **discarded** and replaced with the
fallback. See below.

**9. Envelope.** One response shape carrying the reply, its sources, the structured availability,
the stay details known so far, what is still needed, follow-up suggestions, and metadata.

---

## Grounding: three layers, only one of which is a guarantee

The brief asks how hallucinations are prevented. The honest answer is that two of these three
layers only reduce the odds, and the third is the one that actually holds.

**Layer 1 — Retrieval narrows what the model can see.** Fewer irrelevant facts means less
"adjacent fact" drift, where a question about pool hours gets answered with spa hours. This makes
errors less likely. It does not make them impossible.

**Layer 2 — The prompt asks for discipline.** Explicit rules: these facts are your only source,
never fill gaps from general knowledge, cite what you used. Prompts are requests. A model under
pressure will still produce a fluent sentence with an empty citation list.

**Layer 3 — The server validates the citations.** This is the guarantee. The model must return
`sourceIds`; the backend checks each against the facts actually retrieved for that turn. Miss, or
invent an id, and the answer is thrown away before the guest sees it. It is a postcondition in
code, not an instruction in English.

One deliberately strict rule: citing a fact that *exists in the knowledge base but was not
retrieved this turn* is also a violation. It means the model recalled something from training
rather than reading its context — the exact failure being guarded against, even when the recalled
fact happens to be correct.

Because it is enforced server-side, it holds regardless of which model is behind the interface,
and `tests/integration/chat.test.ts` proves it by scripting a provider that returns a confident,
uncited, wrong answer and asserting the guest never receives it.

---

## What is AI and what is not

This split is the core engineering decision in the project.

| | Handled by the model | Handled by ordinary code |
|---|---|---|
| **Understanding** | Intent, ambiguity, pronouns and ellipsis ("and checkout?") | — |
| **Extraction** | "next Friday, three of us" → typed arguments | — |
| **Reasoning** | Comparing occupancy limits across facts to recommend a room | — |
| **Phrasing** | Turning facts and results into a warm sentence | — |
| **Dates** | — | Validity, ordering, night counts, stay limits |
| **Money** | — | Seasonal and weekend rates, GST slabs, totals |
| **Inventory** | — | Which rooms exist, fit the party, and are free |
| **Truth** | — | Citation validation, refusal, fallback |

The rule: **the model decides what the guest means; code decides what is true.** Anything with a
single correct answer is computed. The model is never asked to agree with a number it did not
produce, because the UI renders those numbers from the structured payload rather than parsing them
out of the reply text.

`POST /api/availability` is this principle made literal — the booking form posts dates and a party
size straight to the engine, with no model in the loop at all. When a guest has used a date picker,
there is nothing to interpret, so interpreting would only add latency, cost and a chance of being
wrong.

---

## Failure behaviour

Every dependency is assumed to fail, and none of them take the feature down with them.

| What fails | What the guest gets |
|---|---|
| Model times out | 15s cap per attempt, 2 jittered retries on transient errors only |
| Model is down | **A real answer from the knowledge base**, prefixed as degraded, `200` not `500` |
| Model is down *and* nothing retrieved | Handoff with the front desk phone number |
| Model returns malformed JSON | Schema check fails, honest fallback |
| Model returns an uncited claim | Discarded, replaced with the fallback, violation logged |
| Repeated model failures | Circuit breaker opens for 30s — guests stop waiting on a dead dependency |
| Tool arguments invalid | Structured tool error → the assistant asks the guest to correct it |
| Guest sends bad input | `400` with field-level detail the UI shows inline |
| Guest floods the endpoint | `429`, `retryable: true`, only on the model-backed route |
| Backend unreachable | Connection banner with Retry; the thread is preserved |

The degraded path is worth emphasising because it falls out of the architecture rather than being
bolted on: the knowledge base lives *outside* the model, so it is still queryable when the model is
gone. Ask for the check-in time with OpenAI unreachable and you still get "2:00 PM", sourced and
cited, with an honest note that the assistant is unavailable.

`AI_PROVIDER=failing` exercises this in the real UI in one command.

---

## Frontend

A single full-height column: sticky header, scrolling thread, pinned composer. No routing and no
modals — a guest with a question should only have to do one thing.

- **`useChat`** is a `useReducer` state machine (`idle | sending | error`). The interesting bugs in
  a chat UI are combinations of state — a reply landing after unmount, a retry firing mid-flight,
  an error that must not wipe the thread — so the transitions are explicit and unit-tested without
  a browser.
- **Loading is staged**, not a spinner: *Thinking* → *Looking through hotel records* → *Checking
  live availability*. Several seconds of an unchanging spinner reads as broken.
- **Replies type out** at ~14ms/char. A structured response arrives all at once, which lands as a
  wall of text; revealing it progressively reads at a human pace. Disabled under
  `prefers-reduced-motion`.
- **Two routes to a date**: the assistant can request one (`needs[]` renders the booking form
  inline in the thread) and the header button opens the same form unprompted. Both submit the same
  structured context.
- **Source chips** make the grounding visible — tap to read the exact fact behind the answer.
- **Refusals are badged** *Not in our records*, so a confident-sounding non-answer cannot be
  mistaken for a fact.
- **Errors are differentiated**: validation inline, rate limit with a wait, model outage as a
  banner that keeps the answer, unreachable backend as a Retry affordance.
- **Accessibility**: `aria-live` thread, labelled inputs, full keyboard operation, visible focus,
  and a light/dark palette driven entirely by CSS custom properties.

---

## Decisions and trade-offs

**Lexical retrieval, not embeddings.** For 47 curated facts, an embeddings call per turn adds
latency and cost, makes tests non-deterministic and breaks the offline mode — in exchange for
recall that a curated synonym table buys for free. `Retriever` is an interface; swapping in a
vector index is one file. Measured results are in [EVALUATION.md](./EVALUATION.md).

**A deterministic offline provider, not a stub.** It reads the same prompt a real model gets,
parsing the fact block and the no-context marker. If the orchestrator stopped putting facts in the
prompt, the mock would fail too — it is a canary, not a rubber stamp. It is also why `npm test`
passes on a fresh clone with no key.

**Seeded inventory, not random.** `hash(roomType + date)` through a small PRNG means the same
search always returns the same answer. Screenshots, tests and the eval suite stay valid
indefinitely, and some dates are genuinely sold out so that path is exercised rather than theorised.

**Structured JSON, not token streaming.** SSE would improve perceived latency but complicates tool
results, error handling and curl-ability. The frontend animates the text instead, which gets most
of the feel for none of the complexity. Streaming is the natural next step.

**In-memory sessions.** A pre-booking chat is short, disposable and personal; nothing here deserves
to survive a restart. The store interface is narrow so Redis is a one-file change — which is
required before running more than one instance.

**Separate API, not Next.js route handlers.** The brief separates frontend and backend and asks for
curl examples. A standalone Express service makes the boundary real, keeps the backend independently
deployable, and means the AI layer is testable without a React toolchain.

---

## Known limitations

These are deliberate scope choices, not oversights. Priorities for productionising are in
[PRODUCT_NOTES.md](./PRODUCT_NOTES.md).

- **Sessions are per-process** — horizontal scaling needs shared storage.
- **Rate limiting is per-instance and in-memory** — same.
- **The knowledge base is a JSON file** — editing it requires a deploy; hotel staff need a CMS.
- **Availability is a mock** — real inventory means a channel manager or CRS integration.
- **No booking.** The assistant quotes, it does not reserve. Taking payment is a different problem
  with different safety requirements.
- **English only.** The knowledge base and the synonym table are both monolingual.
- **No authentication** — nothing here is guest-specific, but "where is my booking?" would need it.
