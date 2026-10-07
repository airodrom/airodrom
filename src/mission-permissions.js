'use strict';
// Additional ceilings only: these permissions never satisfy a grant or approval.
const fs = require('node:fs');
const path = require('node:path');
const LEVELS = Object.freeze(['read_only', 'development', 'repository', 'environment', 'infrastructure', 'production']);
const LABELS = Object.freeze(['Read Only', 'Development', 'Repository', 'Environment', 'Infrastructure', 'Production']);
const DIMENSIONS = Object.freeze({
  repository: { read: 0, write: 1, branch: 1, commit: 1, draft_pr: 1, push: 2, rebase: 2, update_pr: 2, merge: 5 },
  runtime: { diagnostic: 0, test: 1, build: 1, server: 1, restart: 1, install: 1, kill: 3, container: 3, migration: 3 },
  network: { localhost: 0, lan: 3, internet: 1, cloud: 4 },
  secrets: { use: 4, production: 5 },
  data: { read: 0, workspace_write: 1, personal_memory: 1, project_memory: 1, local_database: 3, production: 5, payment: 5 }
});
const copy = value => JSON.parse(JSON.stringify(value));
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error('Invalid mission authority fields');
}
function canonical(target) {
  let current = path.resolve(target), suffix = [];
  while (!fs.existsSync(current)) { const parent = path.dirname(current); if (parent === current) throw Error('Invalid authority path'); suffix.unshift(path.basename(current)); current = parent; }
  return path.join(fs.realpathSync(current), ...suffix);
}
function inside(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function normalizeAuthority(input, { workspace, now = Date.now(), operator = false, inherited = false } = {}) {
  object(input, ['level', 'permissions', 'filesystem', 'expiresAt']);
  const index = LEVELS.indexOf(input.level);
  if (index < 0) throw Error('Unknown mission authority level');
  if (index >= 4 && (!operator || inherited)) throw Error('Infrastructure and Production require explicit operator authority');
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 24 * 60 * 60 * 1000) throw Error('Mission authority requires an expiry within 24 hours');
  const permissions = {};
  if (input.permissions !== undefined) object(input.permissions, Object.keys(DIMENSIONS));
  for (const [dimension, flags] of Object.entries(DIMENSIONS)) {
    // Secrets, external networks and production data are always opt-in.
    const defaults = Object.keys(flags).filter(flag => flags[flag] <= index && !['secrets', 'network'].includes(dimension) && flags[flag] < 5 && !['personal_memory','project_memory'].includes(flag));
    const selected = input.permissions?.[dimension] ?? (dimension === 'network' ? ['localhost'] : defaults);
    if (!Array.isArray(selected) || selected.some(flag => !Object.hasOwn(flags, flag) || flags[flag] > index) || new Set(selected).size !== selected.length) throw Error('Permission exceeds mission authority level');
    permissions[dimension] = [...selected].sort();
  }
  const root = fs.realpathSync(workspace);
  const filesystem = input.filesystem ?? { read: [root], write: index ? [root] : [] };
  object(filesystem, ['read', 'write']);
  const roots = {};
  for (const mode of ['read', 'write']) {
    if (!Array.isArray(filesystem[mode]) || filesystem[mode].length > 20 || filesystem[mode].some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw Error('Explicit absolute filesystem roots required');
    roots[mode] = [...new Set(filesystem[mode].map(p => fs.realpathSync(p)))].sort();
    if (!index && mode === 'write' && roots[mode].length) throw Error('Read Only cannot grant filesystem writes');
    if (!operator && roots[mode].some(p => !inside(root, p))) throw Error('External filesystem roots require operator authority');
  }
  return { version: 1, level: input.level, label: LABELS[index], permissions, filesystem: roots, expiresAt: input.expiresAt };
}
function trustedDefault(workspace, defaults = [], now = Date.now()) {
  const root = fs.realpathSync(workspace);
  const entry = defaults.find(item => fs.realpathSync(item.workspace) === root);
  if (!entry) return null;
  if (!['read_only', 'development', 'repository', 'environment'].includes(entry.level)) throw Error('Trusted defaults cannot inherit elevated authority');
  const ttl = entry.ttlMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 24 * 60 * 60 * 1000) throw Error('Invalid trusted authority duration');
  return normalizeAuthority({ level: entry.level, permissions: entry.permissions, filesystem: entry.filesystem, expiresAt: now + ttl }, { workspace: root, now, inherited: true });
}
function checkAuthority(authority, requirements = {}, now = Date.now()) {
  if (!authority) return { allow: true };
  if (authority.version !== 1 || !LEVELS.includes(authority.level) || !Number.isSafeInteger(authority.expiresAt)) return { allow: false, reason: 'Mission authority is invalid' };
  if (now >= authority.expiresAt) return { allow: false, reason: 'Mission authority expired' };
  if (requirements.unknown) return { allow: false, reason: 'Operation has no mission authority mapping' };
  for (const dimension of Object.keys(DIMENSIONS)) for (const flag of requirements[dimension] || []) {
    if (!authority.permissions?.[dimension]?.includes(flag)) return { allow: false, reason: `Mission authority exceeds ${dimension}:${flag}` };
  }
  for (const mode of ['read', 'write']) for (const target of requirements.filesystem?.[mode] || []) {
    let resolved; try { resolved = canonical(target); } catch { return { allow: false, reason: 'Authority path is invalid' }; }
    if (!authority.filesystem?.[mode]?.some(root => inside(root, resolved))) return { allow: false, reason: `Mission filesystem ${mode} boundary exceeded` };
  }
  return { allow: true };
}
const READ = new Set(['read','ls','find','grep','memory_search','personal_memory_get','personal_memory_search','personal_memory_recent','project_list','project_get','project_summary','project_next_action']);
const FILE_READ = new Set(['file_read','file_search','directory_list','file_metadata','file_hash']);
const FILE_WRITE = new Set(['file_write','file_edit','file_create','directory_create','file_copy','file_move','archive_create','archive_extract']);
function callRequirements(call, workspace) {
  const input = call.input || {}, tool = call.toolName;
  const pathInput = tool === 'capability' ? input.input || {} : input;
  const suppliedPaths = ['path','source','destination','archive','directory','root','target','repo'].filter(k => typeof pathInput[k] === 'string').map(k => pathInput[k]);
  if (Array.isArray(pathInput.sources)) suppliedPaths.push(...pathInput.sources);
  // Host scopes expand ~ against their own configured home, which can differ
  // from this process. Require unambiguous paths for a mission ceiling.
  if (suppliedPaths.some(value => typeof value === 'string' && value.startsWith('~'))) return { unknown: true };
  const file = value => path.resolve(workspace, value || '.');
  if (tool.startsWith('personal_memory_')) return { data: ['personal_memory', READ.has(tool) ? 'read' : 'workspace_write'] };
  if (tool.startsWith('project_')) return { data: ['project_memory', READ.has(tool) ? 'read' : 'workspace_write'] };
  if (READ.has(tool)) return { repository: ['read'], data: ['read'], ...(['read','ls','find','grep'].includes(tool) ? { filesystem: { read: [file(input.path)] } } : {}) };
  if (['write','edit'].includes(tool)) return { repository: ['write'], data: ['workspace_write'], filesystem: { write: [file(input.path)] } };
  if (tool === 'bash') return { runtime: ['diagnostic'], repository: ['read'], filesystem: { read: [workspace] } };
  if (['test','build'].includes(tool)) return { runtime: [tool], repository: ['write'], filesystem: { read: [workspace], write: [workspace] } };
  if (tool === 'bridge-maintenance') return { runtime: input.jobName === 'bridge_restart_status' ? ['diagnostic'] : ['restart'] };
  if (tool === 'trusted-development') {
    if (require('./trusted-dev-runner').READ_ONLY_GIT_JOBS.has(input.jobName)) return { repository: ['read'], runtime: ['diagnostic'] };
    if (input.jobName === 'git_commit') return { repository: ['write','commit'] };
    if (input.jobName === 'git_add') return { repository: ['write'] };
    if (input.jobName === 'focused_test' || input.jobName === 'npm_script') return { repository: ['write'], runtime: ['test'], filesystem: { read: [workspace], write: [workspace] } };
    if (['npm_install','npm_ci'].includes(input.jobName)) return { repository: ['write'], runtime: ['install'], filesystem: { read: [workspace], write: [workspace] } };
    return { unknown: true };
  }
  if (tool === 'capability') {
    const name = input.name, args = input.input || {};
    if(name==='browser_research')return {network:['internet'],data:['read'],...(args.action?.type==='authenticate'?{secrets:['use']}:{})};
    if (FILE_READ.has(name) || FILE_WRITE.has(name)) {
      const mode = FILE_READ.has(name) ? 'read' : 'write';
      const paths = ['path','destination','directory','root','target'].filter(k => typeof args[k] === 'string').map(k => file(args[k]));
      const sources = [...(typeof args.source === 'string' ? [file(args.source)] : []), ...(typeof args.archive === 'string' ? [file(args.archive)] : []), ...(Array.isArray(args.sources) ? args.sources.map(file) : [])];
      return { repository: [mode], data: [mode === 'read' ? 'read' : 'workspace_write'], filesystem: { [mode]: paths.length ? [...paths, ...(name === 'file_move' ? sources : [])] : [workspace], ...(sources.length ? { read: sources } : {}) } };
    }
    const git = {git_status:'read',git_diff:'read',git_log:'read',git_show:'read',git_branch_list:'read',git_add:'write',git_stage:'write',git_checkout:'branch',git_commit:'commit',git_push:'push',git_fetch:'read',git_pull:'rebase',git_branch_create:'branch'};
    if (Object.hasOwn(git, name)) return { repository: [git[name]], filesystem: { read: [file(args.repo)], ...(git[name] !== 'read' ? { write: [file(args.repo)] } : {}) }, ...(['git_push','git_fetch','git_pull'].includes(name) ? { network: ['internet'] } : {}) };
    if (name === 'github_pr_create') return { repository: [args.draft === true ? 'draft_pr' : 'update_pr'], network: ['internet'] };
    if (['github_pr_update','github_pr_comment'].includes(name)) return { repository: ['update_pr'], network: ['internet'] };
    if (name === 'github_pr_merge') return { repository: ['merge'], network: ['internet'] };
    if (name === 'vscode_run_task') return { runtime: ['test'], repository: ['read'], filesystem: { read: [file(args.repo)], write: [file(args.repo)] } };
    if (name === 'project_dependency_install') return { repository: ['write'], runtime: ['install'], filesystem: { read: [file(args.repo)], write: [file(args.repo)] } };
    if (['service_start','service_restart','service_stop'].includes(name)) return { runtime: [name === 'service_restart' ? 'restart' : 'server'] };
    if (name === 'process_stop') return { runtime: ['kill'] };
    if (['container_build','container_start','container_stop','container_restart'].includes(name)) return { runtime: ['container'] };
    if (name === 'db_migrate_dev') return { runtime: ['migration'], data: ['local_database'] };
    if (name === 'db_production_mutation') return { data: ['production'] };
    if (name === 'financial_transaction') return { data: ['payment'] };
    if (['cloud_inventory','cloud_health','cloud_logs','cloud_deploy_status','cloud_cost','cloud_iam_mutate','cloud_dns_mutate'].includes(name)) return { network: ['cloud'] };
    if (name === 'cloud_secret_mutate') return { network: ['cloud'], secrets: ['use'] };
    if (name === 'cloud_deploy_production') return { network: ['cloud'], data: ['production'], secrets: ['production'] };
    if (['capability_list','capability_status','command_classify','agent_list','agent_route_suggest'].includes(name)) return { repository: ['read'] };
    return { unknown: true };
  }
  if (tool === 'web_fetch') return { network: ['internet'], data: ['read'] };
  if (tool === 'mission_checkpoint' || tool.startsWith('personal_memory_') || tool.startsWith('project_')) return { data: ['workspace_write'] };
  return { unknown: true };
}
function snapshot(authority, now = Date.now(), revoked = false) {
  return authority ? { ...copy(authority), status: revoked ? 'revoked' : now >= authority.expiresAt ? 'expired' : 'active' } : null;
}
module.exports = { LEVELS, LABELS, DIMENSIONS, normalizeAuthority, trustedDefault, checkAuthority, callRequirements, snapshot };
