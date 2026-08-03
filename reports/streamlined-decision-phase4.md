# Streamlined Decision Phase 4 - Historical Replay

Implemented 2026-08-03. The authenticated comparison endpoint reads at most the
latest 100 closed and rejected records, uses only their stored point-in-time
summary, and marks missing or incomplete evidence unavailable. It reports
coverage, agreements, disagreements, winners preserved/blocked, and poor
entries rejected/allowed. It never reconstructs old evidence from current data.
