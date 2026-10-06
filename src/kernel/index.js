'use strict';
// Versioned host composition entry point. The existing state machines remain
// canonical; apps consume SDK ports instead of this implementation surface.
const { KERNEL_VERSION } = require('../sdk');
module.exports = Object.freeze({
  version: KERNEL_VERSION,
  MissionAuthority: require('../mission-authority').MissionAuthority,
  MissionService: require('../mission-service').MissionService,
  QualifiedCodingAdapter: require('../qualified-coding-adapter').QualifiedCodingAdapter,
  DeterministicAcceptance: require('../deterministic-acceptance').DeterministicAcceptance,
  MissionProgram: require('../mission-program').MissionProgram,
  ControlContext: require('../control-context').ControlContext,
  PersonalMemory: require('../personal-memory').PersonalMemory,
  NextActionEngine: require('../next-action-engine').NextActionEngine,
  taskHealth: require('../task-health').taskHealth
});
