// Ranks a price's provenance tier for ORDER BY and minimum-tier filters.
export const TIER_RANK_SQL = `CASE tier WHEN 'sold_comps' THEN 3 WHEN 'peer_listings' THEN 2 WHEN 'llm_estimate' THEN 1 ELSE 0 END`
