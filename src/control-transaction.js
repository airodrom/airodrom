'use strict';

// One synchronous unit of work on the existing shared SQLite connection.
const contexts = new WeakMap();
let sequence = 0;
function transaction(db, work) {
  const parent = contexts.get(db);
  const context = { effects: [], rollbacks: [] }, name = `control_${++sequence}`;
  db.exec(`SAVEPOINT ${name}`); contexts.set(db, context);
  let result;
  try {
    result = work();
    if (result?.then) throw new Error('SQLite transactions cannot span asynchronous work');
    db.exec(`RELEASE SAVEPOINT ${name}`);
  } catch (error) {
    try { db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); } catch {}
    if (parent) contexts.set(db, parent); else contexts.delete(db);
    for (const undo of context.rollbacks.reverse()) { try { undo(); } catch {} }
    throw error;
  }
  if (parent) { contexts.set(db, parent); parent.effects.push(...context.effects); parent.rollbacks.push(...context.rollbacks); }
  else { contexts.delete(db); for (const effect of context.effects) effect(); }
  return result;
}
function afterCommit(db, effect) { const context = contexts.get(db); if (context) context.effects.push(effect); else effect(); }
function afterRollback(db, effect) { const context = contexts.get(db); if (context) context.rollbacks.push(effect); }
module.exports = { transaction, afterCommit, afterRollback, inTransaction: db => contexts.has(db) };
