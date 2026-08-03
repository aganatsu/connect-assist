# Streamlined Decision Phase 8 - Controlled Enforcement

Implemented 2026-08-03 with owner approval. Modes are off, observe, and enforce;
the default is observe. Requested enforcement automatically downgrades to
observe unless a non-expired certificate covers the runtime target and style
with at least 100 comparable samples. Certified enforcement fails closed on
incomplete evidence and blocks only when the shared proposed decision does not
allow entry.

Initial scope is certificate-controlled paper trading. Live trading requires a
certificate that explicitly includes `live`. Rollback is immediate: select
observe/off or revoke/expire the certificate. Legacy scoring remains available.
