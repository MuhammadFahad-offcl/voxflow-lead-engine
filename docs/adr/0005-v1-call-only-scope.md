# 0005. v1 stops at the AI call; no email or automated WhatsApp

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Muhammad Fahad
- **PRD links:** Non-goals, FR-27

## Context

Cold email has very low response in the Pakistani SME market and risks domain reputation. Cold WhatsApp through the Business API needs approved templates and opt-in, and complaints can restrict the number. Phone calls are the channel these businesses answer.

## Options considered

1. **Calls only in v1; founder sends confirmations by hand** — fewest platform rules; fastest to ship.
2. **Calls + WhatsApp templates after consent** — better follow-up; Meta setup and template approval delay v1.
3. **Calls + cold email** — low response; deliverability work.

## Decision

v1 contacts businesses only by AI call. The only WhatsApp touch is a dashboard button opening WhatsApp on the founder's phone with a prefilled confirmation he sends himself. No email, no follow-up sequences, no reply handling.

## Consequences

- Any PR adding email, automated WhatsApp or sequences is out of scope and must be rejected until v2 is planned (January 2027).
- WhatsApp-after-consent is the first v2 candidate.
