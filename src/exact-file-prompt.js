'use strict';
// Host-authored OpenCode prompt guidance for exact_file Missions.
// Never alters verifier expectations; only clarifies required bytes to the worker.
function opencodePrompt(mission) {
  const objective = mission.envelope.objective || '';
  const constraints = mission.envelope.constraints || '';
  const exact = (mission.envelope.criteria || []).filter(c => c.type === 'exact_file');
  if (!exact.length) return objective + '\n' + constraints;
  const lines = exact.map(c => {
    const hex = Buffer.from(c.content, 'utf8').toString('hex').match(/.{1,2}/g).join(' ');
    return `- ${c.path}: exact UTF-8 bytes [${hex}] (${Buffer.byteLength(c.content)} bytes). Do not add or remove newline bytes.`;
  });
  return [
    objective,
    constraints,
    'exact_file_bytes (host verifies independently; match these bytes exactly):',
    ...lines,
    'Use edit to replace only the required literal text. Preserve any existing single LF byte exactly. Do not write a second trailing LF.'
  ].filter(Boolean).join('\n');
}
module.exports = { opencodePrompt };
