# DeepSeek reserve provider V1

Decision record: [ADR 0032](adr/0032-deepseek-reserve-provider.md).

DeepSeek is an optional reserve model. It is **off by default**, and Airodrom never
uses it on its own or as a fallback for Qwen, OpenCode, Claude Code or any other
provider. Every request is approved by you, once, in the Control Center.

## Store the API key

In Terminal, run:

```
security add-generic-password -s airodrom.deepseek -a api-key -w
```

`security` then prompts for the key, so it never appears in your shell history,
chat or logs. Never paste the key into ChatGPT, Codex or any other chat. To replace
it later, add `-U`.

## Turn it on

Control Center → **Models** → *DeepSeek reserve* → **Enable reserve**. Then use
**Verify connection** to run an authenticated model-list check that sends no prompt
or data. Turning the reserve off withdraws every approval that hasn't been used.

## Make a request

1. Fill in the model, data classification, why DeepSeek is needed, the exact scope
   being sent, the message and the maximum output.
2. **Request approval**. The card shows:
   1. the model
   2. the reason
   3. the data classification
   4. the exact scope
   5. the token bounds
   6. the estimated cost at current rates
   7. the maximum spend
   8. when the approval expires (after 10 minutes)
3. **Approve once**. For private, financial or sensitive data you must also tick the
   authorization box for that scope.
4. **Send once to DeepSeek**. The request is made exactly once. The answer is
   unverified and is never accepted on Airodrom's behalf.

Each approval covers only that request. If anything about the request changes, the
approval stops working.

## What is never sent

Credentials and secret-like text, Personal Memory, attachments, project context and
other connected-account data. Only the message you typed leaves the Mac.

## Pricing and times

Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday, excluding Chinese public
holidays. All other hours are off-peak at half price. In Vancouver, peak begins on
Sunday evening at 6 PM PDT (5 PM PST), and the second window runs past local
midnight. The panel shows the current period, the rates for both models, the next
peak start and end in Vancouver time, and a live countdown to the next price change.

Marked *(assumed)*: periods are billed conservatively at peak when the holiday
calendar for that year isn't verified, when a Chinese make-up workday falls on a
weekend (for example, Saturday, October 10, 2026), or when pricing was last verified
more than 45 days ago. Rates live in `config/deepseek-reserve-v1.json`, along with
their source and verification date.

## Budget

The default budget is $10 per Vancouver calendar month. Before sending, Airodrom
reserves the request's maximum possible cost; if that doesn't fit, nothing is sent.
Afterwards it charges what DeepSeek reports, splitting input into cache hits and
misses and adding output. A refused request costs nothing. If the outcome is unknown
(a timeout, network error, cancellation in flight, or restart), the full
reservation stays counted as *unreconciled*.

This is a local ledger, not a limit DeepSeek enforces. Set a spending limit or top-up
amount in your DeepSeek account as well.

## Limitations

- Not tested against the live API; only synthetic tests ran.
- There is no command yet to reconcile *unreconciled* charges with DeepSeek's billing.
- Holiday dates are verified for 2026 only. Add each new State Council calendar to the config.
