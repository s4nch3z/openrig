import type { Migration } from "../migrate.js";

/**
 * Claim on wake: `claim_on_wake` is the row's opt-in (`rig queue create --claim-on-wake`) to be claimed by the wake that
 * carries its complete body, instead of by a manual claim; existing rows keep manual claims. `claim_wake_outbox_id` and
 * `claim_wake_transition_id` name the wake and the claim transition of a claim the wake made, so that exact claim can be
 * recognized later, and undone only while it is still the row's newest transition.
 */
export const queueClaimOnWakeSchema: Migration = {
  name: "196_queue_claim_on_wake.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN claim_on_wake INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE queue_items ADD COLUMN claim_wake_outbox_id TEXT;
    ALTER TABLE queue_items ADD COLUMN claim_wake_transition_id INTEGER;
  `,
};
