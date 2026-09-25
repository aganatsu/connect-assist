-- Give the two decision OUTPUTS their own digests.
--
-- `gates_hash` and `portfolio_hash` cover the INPUTS to those stages. The gate
-- result array and the portfolio-conflict result are outputs `scan_logs` never
-- carried, so they are stored here — and until now stored without
-- tamper-evidence, unlike every other recorded artefact in this programme.
--
-- Found by the pre-deploy round trip rather than in review: the verification
-- pass had nothing to check them against, which is itself the signal.

alter table public.smc_scan_decision
  add column if not exists gates_output_hash     text,
  add column if not exists portfolio_output_hash text;
