'use strict';
const TRANSITIONS = Object.freeze({
  planned:['ready','cancelled'], ready:['dispatching','cancelled','blocked'],
  dispatching:['running','blocked','cancelled'], running:['waiting_for_operator','verifying','blocked','needs_rework','cancelled'],
  waiting_for_operator:['ready','blocked','cancelled'], waiting_for_dependency:['ready','blocked','cancelled'],
  verifying:['awaiting_acceptance','needs_rework','blocked','cancelled'],
  awaiting_acceptance:['completed','verifying','needs_rework','blocked','cancelled'],
  needs_rework:['ready','verifying','cancelled'], blocked:['ready','cancelled'], cancelled:[], completed:[]
});
function assertTransition(from,to) {if(!TRANSITIONS[from]?.includes(to))throw new Error(`Invalid Mission transition: ${from} → ${to}`);}
module.exports={TRANSITIONS,assertTransition};
