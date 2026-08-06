# Automatic Trade Review Journal

## Purpose

History is the immutable execution ledger. Journal reads that ledger and adds a
review layer; it does not copy or alter closed trades.

## Views

- Review Queue: automatically closed bot trades not yet reviewed.
- Reviewed: trades with an owner-completed review.
- Model Insights: outcomes grouped by setup, session, regime and evidence tags.

## Data ownership

- `paper_trade_history`: entry, exit, P&L and close reason.
- `trade_post_mortems`: generated outcome explanation.
- `signal_reason`: frozen setup and execution evidence.
- `trade_review_notes`: optional owner observation, lesson, tags and status.

Manual `trades` records remain for compatibility but are not the bot Journal
authority.
