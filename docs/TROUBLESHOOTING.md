# Troubleshooting

If the runtime reports missing SQLite/FTS5, check the selected Node version and run the read-only in-memory SQLite probe described by `scripts/run.cjs`. Do not replace or install system runtimes automatically. A missing operator sandbox manifest is an intentional denial: obtain a reviewed inventory for this host, rather than copying historical pins.

For startup/profile errors, verify private profile location and non-secret settings locally. Do not share auth files, environment dumps, raw argv, runtime discovery or task databases. `node scripts/harness-safe-status.cjs` emits allowlisted health metadata when an authorized local service is already available; it does not start one.

A held or quarantined writer requires trusted lifecycle reconciliation. Restart, timeout or a cancellation request alone does not prove safe release. Incomplete erasure/restore authority denies retained reads; retry through supported host maintenance in quarantine and retain independent current dispositions.

For bugs, provide the candidate version, runtime tier, safe error class and minimal seeded reproduction. For confidential vulnerabilities follow [SECURITY.md](../SECURITY.md). Never include private account or session details.
