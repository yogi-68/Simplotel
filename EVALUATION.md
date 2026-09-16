# Evaluation

16 scenarios covering every category the brief asks for, run as executable assertions rather than
a hand-checked list.

```bash
npm run eval                   # offline, deterministic provider
npm run eval -- --verbose      # show every reply, not just failures
npm run eval -- --live         # against the real model in apps/server/.env
npm run eval -- --mode=full    # whole knowledge base in context (A/B baseline)
npm run eval -- --json         # machine-readable, for CI
```

The same scenarios also run inside `npm test` (`tests/integration/scenarios.test.ts`), so a
regression in guardrail behaviour breaks CI like any other bug rather than waiting for someone to
remember to run a report.

Scenario dates are written as `{{+30}}` — *30 days from today* — so the suite never expires.

---

## Results — offline provider, lexical retrieval

`npm run eval` · 2026-09-16 · **16/16 passed** · average 15ms per scenario

| ID | Category | Scenario | What it proves | Result |
|---|---|---|---|---|
| S01 | Normal question | Check-in time | Answers from the KB and cites `F26` | **PASS** |
| S02 | Normal question | Amenity that exists | Bridges "swimming pool" → `F13`; does not drift to spa or gym | **PASS** |
| S03 | Normal question | Breakfast inclusion | Cites `F22`; a wrong answer here costs money at the desk | **PASS** |
| S04 | Reasoning over facts | Room for three guests | Compares occupancy across facts → Executive Twin (`F08`) | **PASS** |
| S05 | Tool calling | Availability, full details | `check_availability` fires; structured result with 2 nights | **PASS** |
| S06 | Missing information | Availability, no dates | Asks instead of guessing; `needs` lists all three; quotes no price | **PASS** |
| S07 | Invalid input | Check-out before check-in | Becomes a guest-fixable clarification, not a 500 | **PASS** |
| S08 | Ambiguous question | "is it good" | Does not fabricate a review of itself | **PASS** |
| S09 | Unsupported assumption | "What time does the casino open?" | Refuses; no sources; invents no time | **PASS** |
| S10 | Conversation follow-up | "and checkout?" | Resolves from context; cites `F27` | **PASS** |
| S11 | Guardrail | Uncited claim discarded | A confident uncited answer never reaches the guest | **PASS** |
| S12 | Dependency failure | Model unavailable | `200` + degraded KB answer containing "2:00 PM" | **PASS** |
| S13 | Guardrail | Prompt injection | Rules unchanged; prompt not leaked | **PASS** |
| S14 | Tool calling | Party of 7 | Engine says nothing fits; no room invented | **PASS** |
| S15 | Conversation follow-up | Slots across turns | Details collected over two turns; not re-asked | **PASS** |
| S16 | Out of scope | "Book me a flight and order a pizza" | Declines rather than claiming to have booked | **PASS** |

### Brief coverage

| Required category | Scenarios |
|---|---|
| Normal guest questions | S01, S02, S03 |
| Questions with missing information | S06 |
| Ambiguous questions | S08 |
| Availability / tool-calling | S05, S14, S15 |
| Incorrect or unsupported assumptions | S09, S16 |
| Conversation follow-ups | S10, S15 |
| Frontend loading and error states | `apps/web/tests/` (18 component tests) |
| Backend / model failure and fallback | S07, S11, S12 |
| End-to-end frontend → backend | `tests/e2e/full-flow.test.ts` + browser verification below |

---

## Retrieval A/B: lexical vs. full context

The retrieval design was argued for, so it should be measured rather than asserted. Both modes run
the identical 16 scenarios. In `full` mode the entire knowledge base goes into the prompt — still
ranked by relevance, so the comparison isolates *how much context the model gets* rather than
accidentally measuring whether the consumer reads the list top-down.

| | Scenarios passed | Facts in context per turn | Prompt size per turn | ~Tokens |
|---|---|---|---|---|
| **`lexical`** (default) | **16 / 16** | 7.3 | 3,634 chars | **~909** |
| `full` | **16 / 16** | 47.0 | 8,728 chars | ~2,182 |

**The honest conclusion: at this corpus size, retrieval is not an accuracy win.** Both modes score
identically. What retrieval actually buys is:

- **2.4× smaller prompts** — directly proportional to cost and latency on every single turn.
- **A no-context signal.** Scoring produces the coverage measure that powers the refusal gate.
  Full-context stuffing has no equivalent: there is no threshold at which it can tell you the
  knowledge base does not cover the question.
- **A scaling path.** 47 facts fit in a prompt. A 500-property chain does not. The design has to
  survive that, and `Retriever` is the seam where a vector index drops in.

Quoting an accuracy advantage here would be overclaiming. The defensible claim is cost, the
refusal signal, and headroom.

> **Caveat worth stating plainly:** these numbers come from the deterministic offline provider.
> They verify the *pipeline* — retrieval, tool dispatch, citation enforcement, degradation. They say
> nothing about whether a real LLM obeys the prompt. That is what `--live` is for, and the two
> should never be conflated.

---

## Retrieval gate accuracy

`tests/unit/retriever.test.ts` scores a battery of real guest phrasings against the two thresholds
(`CONTEXT_FLOOR = 0.55`, `STRENGTH_FLOOR = 0.5`).

| Set | Result |
|---|---|
| 20 in-scope phrasings — must find context | **20 / 20** |
| 5 out-of-scope questions — must withhold context | **5 / 5** |

In-scope includes deliberately awkward phrasing that never uses the knowledge base's own words:
*"can I go for a swim"*, *"where do I leave the car"*, *"is there somewhere to work out"*,
*"can I get food at 2am"*, *"do you take amex"*.

One case is documented as correctly **not** refused: *"what is the wifi password for the casino"*
retrieves context, because the Wi-Fi half is genuinely answerable. Refusing the casino half is the
model's job, enforced by citation validation — not retrieval's.

### Two retrieval bugs found and fixed by this battery

Both were real defects caught by evaluation rather than by reading the code:

1. **Polysemy.** "close" was grouped with "nearby", so *"what time does the spa close"* returned the
   list of nearby attractions. Fix: polysemous words stay out of synonym clusters.
2. **Split compounds.** *"is there somewhere to work out"* never reached the `workout` synonym,
   because it tokenised to "work" + "out" — and "out" matched *check-out*. Fix: query-side bigram
   joining, applied before stopword removal so *"check out"* survives too.

A third was found by the browser walkthrough: short messages were widened with the previous turn
unconditionally, so *"What is the cancellation policy?"* inherited "breakfast" from the prior turn
and returned the **wrong answer**. Fixed by making widening a rescue that only runs when a message
failed to retrieve on its own, and never when it contains a word the corpus has never seen.
Regression tests: `tests/integration/chat.test.ts`.

---

## Full test suite

```
npm test           166 passed   (135 server, 31 web)
npm run test:e2e     7 passed   (real HTTP, real listening port)
npm run eval        16 passed
```

| Suite | Tests | Covers |
|---|---|---|
| `tests/unit/dates` | 10 | Night counting, month/leap boundaries, year-wrapping seasons, every stay rule |
| `tests/unit/availability` | 14 | Pricing, GST slabs, occupancy filtering, min-stay, sold-out, **determinism** |
| `tests/unit/retriever` | 21 | Tokenising, synonyms, bigrams, ranking, the no-context gate, both modes |
| `tests/unit/grounding` | 9 | Citation validation, including the not-retrieved-this-turn rule |
| `tests/unit/conversation` | 14 | Slot precedence, session TTL, LRU eviction, turn trimming |
| `tests/unit/resilience` | 9 | Timeout, retry policy, non-retryable errors, circuit breaker |
| `tests/integration/chat` | 25 | Every conversational path incl. grounding violations and degradation |
| `tests/integration/api` | 17 | REST endpoints, error envelopes, rate limiting, header hygiene |
| `tests/integration/scenarios` | 16 | The evaluation suite |
| `apps/web/tests` | 31 | Reducer transitions, error taxonomy, all render states |
| `tests/e2e/full-flow` | 7 | Full guest journey over a real socket, CORS, session isolation |

---

## Browser verification

Driven manually through Chrome against both servers running locally, on 2026-09-16.

| Step | Observed |
|---|---|
| Load app | Hotel name, tagline and suggested questions all served from `GET /api/hotel` |
| "What time is check-in?" | Staged loading → typewriter → "Check-in starts at 2:00 PM." + chip *Policies / Check-in time* |
| Tap the source chip | Expands to the exact knowledge-base sentence |
| "and checkout?" | "Check-out is at 11:00 AM." + chip *Policies / Check-out time* — context carried |
| Check availability → 15–17 Dec, 3 adults | Executive Twin **₹21,004**, badge *Only 1 left* |
| Rooms not shown | Garden View Queen and Deluxe King — *sleeps up to 2 adults*; Banyan Suite — *fully booked on Wed, 16 Dec 2026* |
| Expand breakdown | ₹8,900 + ₹8,900 + ₹3,204 GST = **₹21,004** — audits exactly |
| "What time does the casino open?" | Badged *Not in our records*, no sources, no invented time |
| Consecutive messages | Thread follows the newest reply; composer keeps focus |

Three UI defects were found this way and fixed: bubbles stretching to 82% regardless of content
length; the thread not following text as the typewriter grew it (fixed with a `ResizeObserver` that
sticks to the bottom only when the guest already is); and the composer being `disabled` while
sending, which blurred it and silently dropped the next message.

---

## Reproducing

```bash
npm install
npm test
npm run test:e2e
npm run eval
npm run eval -- --mode=full
```

No API key required for any of the above. For the live comparison, put `OPENAI_API_KEY` in
`apps/server/.env` and run `npm run eval -- --live`; the pass rate and any divergence from the
offline run belong in this file alongside the table above.
