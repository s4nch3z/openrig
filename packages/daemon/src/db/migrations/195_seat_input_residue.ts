import type { Migration } from "../migrate.js";

/** A queue wake whose text was pasted into a seat but whose Enter wasn't sent (the wake no longer applied, its row
 *  erased or settled, or the seat changed). The paste may still sit in that pane process's input, so automatic sends to it hold until
 *  it reads empty. One row per pane process of a seat; only where it was pasted is kept, never the text: erasure clears
 *  the wake's outbox row and must not lose this hold. */
export const seatInputResidueSchema: Migration = {
  name: "195_seat_input_residue.sql",
  sql: `
    CREATE TABLE seat_input_residue (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      session_name TEXT NOT NULL,
      pane TEXT,
      pane_pid INTEGER,
      occupant TEXT,
      outbox_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_seat_input_residue_node ON seat_input_residue(node_id);
  `,
};
