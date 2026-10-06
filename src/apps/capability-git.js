'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { keys, text, integer, bool, list, oneOf, pattern, fail, redactText } = require('../capability-util');

const GIT_CANDIDATES = ['/usr/bin/git', '/opt/homebrew/bin/git'];
const GH_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,200}(?<![./])$/;
const REMOTE = /^[A-Za-z0-9._-]{1,64}$/;
const PROTECTED_BRANCHES = /^(?:main|master|trunk|develop|development|production|prod|staging|stable|release(?:[/-].*)?|hotfix\/.*|gh-pages)$/;

function git(ctx) { const file = ctx.exec.resolveFirst(GIT_CANDIDATES); if (!file) fail('Git is not installed'); ctx.exec.allow(file); return file; }
function gh(ctx) { const file = ctx.exec.resolveFirst(GH_CANDIDATES); if (!file) fail('GitHub CLI is not installed'); ctx.exec.allow(file); return file; }

const NETWORK_ENV = ctx => ({ GIT_TERMINAL_PROMPT: '0', ...(ctx.env?.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: ctx.env.SSH_AUTH_SOCK } : {}) });

async function run(ctx, repo, args, { network = false, allowFailure = false, timeoutMs = 60_000, input = null } = {}) {
  const result = await ctx.exec.run(git(ctx), ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], { cwd: repo, timeoutMs, input, env: { GIT_OPTIONAL_LOCKS: '0', ...(network ? NETWORK_ENV(ctx) : { GIT_TERMINAL_PROMPT: '0' }) } });
  if (result.exitCode !== 0 && !allowFailure) fail(`git ${args[0]} failed: ${redactText(result.stderr || result.stdout, 400)}`);
  return result;
}

function repository(ctx, value, { write = false } = {}) {
  const resolved = ctx.scopes.approvedRepository(value, { workspace: ctx.task.workspace, write });
  if (!fs.existsSync(path.join(resolved.canonical, '.git'))) fail('Path is not the root of a Git repository');
  return resolved;
}

async function currentBranch(ctx, repo) { return (await run(ctx, repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })).stdout.trim() || null; }
async function defaultBranch(ctx, repo, remote = 'origin') {
  const head = (await run(ctx, repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], { allowFailure: true })).stdout.trim();
  return head ? head.replace(`${remote}/`, '') : null;
}
async function isProtected(ctx, repo, branch, remote = 'origin') {
  if (PROTECTED_BRANCHES.test(branch)) return true;
  const configured = (ctx.protectedBranches || []).includes(branch);
  return configured || branch === await defaultBranch(ctx, repo, remote);
}

function touchedIn(ctx, repo) {
  const set = new Set();
  for (const file of ctx.touched()) {
    const relative = path.relative(repo, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) set.add(relative.split(path.sep).join('/'));
  }
  return set;
}

function relativePaths(value) {
  return list(value, 'paths', { max: 500, item: entry => {
    text(entry, 'path', { max: 1_000, multiline: false });
    if (entry.startsWith('-') || entry.startsWith('/') || entry.startsWith(':') || /[*?[\]]/.test(entry) || ['.', '..'].includes(entry) || entry.split('/').includes('..')) fail('Stage paths must be explicit repository-relative file paths without globs');
    return entry;
  } });
}

async function stagedFiles(ctx, repo) { return (await run(ctx, repo, ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean); }

function gitCapabilities() {
  const repoOnly = input => { keys(input, ['repo']); text(input.repo, 'repo'); return input; };
  return {
    git_status: {
      validate: repoOnly, assess: (ctx, input) => ({ scope: repository(ctx, input.repo).scope }),
      perform: async (ctx, input) => {
        const repo = repository(ctx, input.repo).canonical;
        const result = await run(ctx, repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
        const records = result.stdout.split('\0').filter(Boolean);
        const header = Object.fromEntries(records.filter(line => line.startsWith('# ')).map(line => { const [, key, ...rest] = line.split(' '); return [key, rest.join(' ')]; }));
        const files = records.filter(line => !line.startsWith('# ')).slice(0, 1_000).map(line => {
          if (line.startsWith('? ')) return { path: line.slice(2), status: 'untracked' };
          const parts = line.split(' ');
          return { path: parts.slice(line.startsWith('2 ') ? 9 : 8).join(' '), status: parts[1] };
        });
        const touched = touchedIn(ctx, repo);
        return { repo: ctx.scopes.display(repo), branch: header['branch.head'] || null, upstream: header['branch.upstream'] || null, ahead_behind: header['branch.ab'] || null, files: files.map(file => ({ ...file, task_owned: touched.has(file.path) })), clean: files.length === 0 };
      }
    },
    git_diff: {
      validate: input => { keys(input, ['repo'], ['staged', 'paths', 'stat']); text(input.repo, 'repo'); bool(input.staged, 'staged'); bool(input.stat, 'stat'); if (input.paths !== undefined) relativePaths(input.paths); return input; },
      assess: (ctx, input) => ({ scope: repository(ctx, input.repo).scope }),
      perform: async (ctx, input) => {
        const repo = repository(ctx, input.repo).canonical;
        const args = ['diff', '--no-ext-diff', ...(input.staged ? ['--cached'] : []), ...(input.stat ? ['--stat'] : []), '--', ...(input.paths || [])];
        const result = await run(ctx, repo, args, { timeoutMs: 60_000 });
        return { repo: ctx.scopes.display(repo), staged: input.staged === true, diff: redactText(result.stdout, 200_000), truncated: result.stdout.length > 200_000 || result.truncated };
      }
    },
    git_log: {
      validate: input => { keys(input, ['repo'], ['maxCount', 'ref']); text(input.repo, 'repo'); integer(input.maxCount, 'maxCount', { min: 1, max: 200, optional: true }); pattern(input.ref, BRANCH, 'ref', { optional: true }); return input; },
      assess: (ctx, input) => ({ scope: repository(ctx, input.repo).scope }),
      perform: async (ctx, input) => {
        const repo = repository(ctx, input.repo).canonical;
        const result = await run(ctx, repo, ['log', `--max-count=${input.maxCount || 20}`, '--format=%H%x1f%an%x1f%aI%x1f%s', ...(input.ref ? [input.ref, '--'] : [])]);
        return { commits: result.stdout.split('\n').filter(Boolean).map(line => { const [sha, author, date, subject] = line.split('\x1f'); return { sha, author, date, subject }; }) };
      }
    },
    git_branch_list: {
      validate: repoOnly, assess: (ctx, input) => ({ scope: repository(ctx, input.repo).scope }),
      perform: async (ctx, input) => {
        const repo = repository(ctx, input.repo).canonical;
        const result = await run(ctx, repo, ['for-each-ref', '--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)', 'refs/heads']);
        const branches = result.stdout.split('\n').filter(Boolean).map(line => { const [name, upstream, track, head] = line.split('\x1f'); return { name, upstream: upstream || null, track: track || null, current: head === '*', protected: PROTECTED_BRANCHES.test(name) }; });
        return { branches, default_branch: await defaultBranch(ctx, repo) };
      }
    },
    git_branch_create: {
      validate: input => { keys(input, ['repo', 'name'], ['startPoint', 'checkout']); text(input.repo, 'repo'); pattern(input.name, BRANCH, 'branch name'); pattern(input.startPoint, BRANCH, 'startPoint', { optional: true }); bool(input.checkout, 'checkout'); return input; },
      assess: (ctx, input) => ({ scope: repository(ctx, input.repo, { write: true }).scope, dynamic: PROTECTED_BRANCHES.test(input.name) ? { decision: 'approval_required', reason: 'Creating a protected branch name requires approval' } : null }),
      perform: async (ctx, input) => {
        const repo = repository(ctx, input.repo, { write: true }).canonical;
        await run(ctx, repo, ['check-ref-format', '--branch', input.name]);
        await run(ctx, repo, input.checkout ? ['switch', '-c', input.name, ...(input.startPoint ? [input.startPoint] : [])] : ['branch', '--', input.name, ...(input.startPoint ? [input.startPoint] : [])]);
        return { branch: input.name, checked_out: input.checkout === true };
      }
    },
    git_checkout: {
      validate: input => { keys(input, ['repo', 'branch']); text(input.repo, 'repo'); pattern(input.branch, BRANCH, 'branch'); return input; },
      assess: (ctx, input) => ({ scope: repository(ctx, input.repo, { write: true }).scope }),
      // `git switch` without --force refuses to overwrite local changes.
      perform: async (ctx, input) => { const repo = repository(ctx, input.repo, { write: true }).canonical; await run(ctx, repo, ['switch', '--no-guess', '--', input.branch].filter(arg => arg !== '--')); return { branch: input.branch, switched: true }; }
    },
    git_stage: {
      validate: input => { keys(input, ['repo', 'paths']); text(input.repo, 'repo'); relativePaths(input.paths); if (!input.paths.length) fail('Invalid paths'); return input; },
      assess: (ctx, input) => {
        const repo = repository(ctx, input.repo, { write: true });
        const touched = touchedIn(ctx, repo.canonical);
        const foreign = input.paths.filter(file => !touched.has(file));
        return { scope: repo.scope, dynamic: foreign.length ? { decision: 'approval_required', reason: `Files not known to belong to this task: ${foreign.slice(0, 10).join(', ')}` } : null, facts: { task_owned: input.paths.length - foreign.length, foreign: foreign.length } };
      },
      perform: async (ctx, input) => {
        const repo = repository(ctx, input.repo, { write: true }).canonical;
        for (const file of input.paths) if (ctx.scopes.isSensitive(path.join(repo, file))) fail('Sensitive files are never staged');
        await run(ctx, repo, ['add', '--', ...input.paths]);
        return { staged: input.paths, staged_total: (await stagedFiles(ctx, repo)).length };
      }
    },
    git_commit: {
      validate: input => { keys(input, ['repo', 'message']); text(input.repo, 'repo'); text(input.message, 'message', { max: 8_000 }); return input; },
      assess: async (ctx, input) => {
        const repo = repository(ctx, input.repo, { write: true });
        const staged = await stagedFiles(ctx, repo.canonical);
        if (!staged.length) return { scope: repo.scope, dynamic: { decision: 'deny', kind: 'capability_denied', reason: 'Nothing is staged' } };
        const touched = touchedIn(ctx, repo.canonical);
        const foreign = staged.filter(file => !touched.has(file));
        return { scope: repo.scope, dynamic: foreign.length ? { decision: 'approval_required', reason: `Staged files not known to belong to this task: ${foreign.slice(0, 10).join(', ')}` } : null, facts: { staged: staged.length } };
      },
      perform: async (ctx, input) => {
        const repo = repository(ctx, input.repo, { write: true }).canonical;
        await run(ctx, repo, ['commit', '--file=-', '--no-edit'], { input: input.message, timeoutMs: 120_000 });
        const sha = (await run(ctx, repo, ['rev-parse', 'HEAD'])).stdout.trim();
        return { committed: true, sha, branch: await currentBranch(ctx, repo) };
      }
    },
    git_fetch: {
      validate: input => { keys(input, ['repo'], ['remote']); text(input.repo, 'repo'); pattern(input.remote, REMOTE, 'remote', { optional: true }); return input; },
      assess: (ctx, input) => ({ scope: repository(ctx, input.repo).scope }),
      perform: async (ctx, input) => { const repo = repository(ctx, input.repo).canonical; await run(ctx, repo, ['fetch', '--no-write-fetch-head', input.remote || 'origin'], { network: true, timeoutMs: 180_000 }); return { fetched: true, remote: input.remote || 'origin' }; }
    },
    git_pull: {
      validate: input => { keys(input, ['repo'], ['mode']); text(input.repo, 'repo'); oneOf(input.mode, ['ff_only', 'rebase'], 'mode', { optional: true }); return input; },
      assess: async (ctx, input) => {
        const repo = repository(ctx, input.repo, { write: true });
        if ((input.mode || 'ff_only') === 'ff_only') return { scope: repo.scope };
        // Rebasing commits that already exist on any remote rewrites published history.
        const local = (await run(ctx, repo.canonical, ['rev-list', '@{upstream}..HEAD'], { allowFailure: true })).stdout.split('\n').filter(Boolean);
        for (const sha of local.slice(0, 200)) {
          const remotes = (await run(ctx, repo.canonical, ['branch', '-r', '--contains', sha], { allowFailure: true })).stdout.trim();
          if (remotes) return { scope: repo.scope, dynamic: { decision: 'approval_required', riskClass: 'DESTRUCTIVE', v1Category: 'destructive_git_unique', reason: 'Rebase would rewrite commits that are already published' } };
        }
        return { scope: repo.scope };
      },
      perform: async (ctx, input) => {
        const repo = repository(ctx, input.repo, { write: true }).canonical;
        const result = await run(ctx, repo, ['pull', (input.mode || 'ff_only') === 'rebase' ? '--rebase' : '--ff-only'], { network: true, timeoutMs: 300_000 });
        return { pulled: true, mode: input.mode || 'ff_only', output: redactText(result.stdout, 4_000) };
      }
    },
    git_push: {
      validate: input => { keys(input, ['repo'], ['remote', 'branch', 'setUpstream', 'force']); text(input.repo, 'repo'); pattern(input.remote, REMOTE, 'remote', { optional: true }); pattern(input.branch, BRANCH, 'branch', { optional: true }); bool(input.setUpstream, 'setUpstream'); bool(input.force, 'force'); return input; },
      assess: async (ctx, input) => {
        const repo = repository(ctx, input.repo);
        const branch = input.branch || await currentBranch(ctx, repo.canonical);
        if (!branch) return { scope: repo.scope, dynamic: { decision: 'deny', kind: 'capability_denied', reason: 'Detached HEAD cannot be pushed by name' } };
        if (await isProtected(ctx, repo.canonical, branch, input.remote || 'origin')) return { scope: repo.scope, dynamic: { decision: 'approval_required', riskClass: 'DESTRUCTIVE', v1Category: 'git_push_protected', reason: `Push to protected branch ${branch} requires approval` }, facts: { branch, protected: true } };
        if (input.force) return { scope: repo.scope, dynamic: { decision: 'approval_required', riskClass: 'DESTRUCTIVE', v1Category: 'destructive_git_unique', reason: 'Force push rewrites remote history and requires approval' }, facts: { branch, force: true } };
        return { scope: repo.scope, facts: { branch, protected: false } };
      },
      perform: async (ctx, input) => {
        const repo = repository(ctx, input.repo).canonical;
        const branch = input.branch || await currentBranch(ctx, repo);
        const args = ['push', ...(input.setUpstream ? ['--set-upstream'] : []), ...(input.force ? ['--force-with-lease'] : []), input.remote || 'origin', `refs/heads/${branch}:refs/heads/${branch}`];
        const result = await run(ctx, repo, args, { network: true, timeoutMs: 300_000 });
        return { pushed: true, remote: input.remote || 'origin', branch, forced: input.force === true, output: redactText(result.stderr, 2_000) };
      }
    },
    git_branch_delete: {
      validate: input => { keys(input, ['repo', 'branch']); text(input.repo, 'repo'); pattern(input.branch, BRANCH, 'branch'); return input; },
      assess: async (ctx, input) => {
        const repo = repository(ctx, input.repo, { write: true });
        if (input.branch === await currentBranch(ctx, repo.canonical)) return { scope: repo.scope, dynamic: { decision: 'deny', kind: 'capability_denied', reason: 'The checked-out branch cannot be deleted' } };
        const base = await defaultBranch(ctx, repo.canonical) || 'HEAD';
        const merged = (await run(ctx, repo.canonical, ['branch', '--merged', base, '--format=%(refname:short)'], { allowFailure: true })).stdout.split('\n').map(line => line.trim());
        const protectedName = PROTECTED_BRANCHES.test(input.branch);
        return { scope: repo.scope, dynamic: protectedName || !merged.includes(input.branch) ? { decision: 'approval_required', riskClass: 'DESTRUCTIVE', v1Category: 'delete_unique_work', reason: protectedName ? 'Protected branch deletion requires approval' : 'Branch has unmerged commits; deletion requires approval' } : null, facts: { merged: merged.includes(input.branch) } };
      },
      perform: async (ctx, input, assessment) => {
        const repo = repository(ctx, input.repo, { write: true }).canonical;
        await run(ctx, repo, ['branch', assessment?.facts?.merged ? '-d' : '-D', '--', input.branch]);
        return { deleted: input.branch, was_merged: assessment?.facts?.merged === true };
      }
    },
    ...githubCapabilities()
  };
}

function githubCapabilities() {
  const repoInput = (required = [], optional = []) => input => { keys(input, ['repo', ...required], optional); text(input.repo, 'repo'); return input; };
  const call = async (ctx, repo, args, { input = null, json = true } = {}) => {
    const result = await ctx.exec.run(gh(ctx), args, { cwd: repo, input, timeoutMs: 60_000, env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1' } });
    if (result.exitCode !== 0) fail(/auth login|not logged/i.test(result.stderr) ? 'GitHub CLI is not authenticated; the human must run gh auth login' : `gh ${args[0]} ${args[1] || ''} failed: ${redactText(result.stderr, 300)}`);
    if (!json) return redactText(result.stdout, 48_000);
    try { return JSON.parse(result.stdout); } catch { return { output: redactText(result.stdout, 8_000) }; }
  };
  const listOptions = input => { oneOf(input.state, ['open', 'closed', 'merged', 'all'], 'state', { optional: true }); integer(input.limit, 'limit', { min: 1, max: 100, optional: true }); pattern(input.branch, BRANCH, 'branch', { optional: true }); if (input.number !== undefined) number(input.number); return input; };
  const read = (args, extra = []) => ({ validate: input => listOptions(repoInput(...extra)(input)), assess: (ctx, input) => ({ scope: repository(ctx, input.repo).scope }), perform: async (ctx, input) => call(ctx, repository(ctx, input.repo).canonical, args(input)) });
  const number = value => integer(value, 'number', { min: 1, max: 10_000_000 });
  const labels = value => list(value, 'labels', { max: 20, item: entry => text(entry, 'label', { max: 50, multiline: false }), optional: true });
  const bodyFile = input => input.body === undefined ? [] : ['--body-file', '-'];
  const write = (validate, args, { stdin = input => input.body ?? null } = {}) => ({
    validate, assess: (ctx, input) => ({ scope: repository(ctx, input.repo).scope }),
    perform: async (ctx, input) => ({ ok: true, output: await call(ctx, repository(ctx, input.repo).canonical, args(input), { input: stdin(input), json: false }) })
  });
  return {
    github_repo_view: read(() => ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,visibility,url,isArchived,viewerPermission']),
    github_issue_list: read(input => ['issue', 'list', '--state', input.state || 'open', '--limit', String(input.limit || 30), '--json', 'number,title,state,url,labels,updatedAt'], [[], ['state', 'limit']]),
    github_issue_view: read(input => (number(input.number), ['issue', 'view', String(input.number), '--json', 'number,title,state,body,url,labels,comments']), [['number'], []]),
    github_pr_list: read(input => ['pr', 'list', '--state', input.state || 'open', '--limit', String(input.limit || 30), '--json', 'number,title,state,url,headRefName,baseRefName,isDraft,updatedAt'], [[], ['state', 'limit']]),
    github_pr_view: read(input => (number(input.number), ['pr', 'view', String(input.number), '--json', 'number,title,state,body,url,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup']), [['number'], []]),
    github_pr_checks: read(input => (number(input.number), ['pr', 'checks', String(input.number), '--json', 'name,state,bucket,link,workflow']), [['number'], []]),
    github_ci_runs: read(input => ['run', 'list', '--limit', String(input.limit || 20), ...(input.branch ? ['--branch', input.branch] : []), '--json', 'databaseId,name,status,conclusion,headBranch,event,url,createdAt'], [[], ['branch', 'limit']]),
    github_issue_create: write(input => { repoInput(['title'], ['body', 'labels'])(input); text(input.title, 'title', { max: 256, multiline: false }); text(input.body, 'body', { max: 65_000, optional: true, min: 0 }); labels(input.labels); return input; },
      input => ['issue', 'create', '--title', input.title, ...bodyFile(input), ...(input.labels || []).flatMap(label => ['--label', label])]),
    github_issue_update: write(input => { repoInput(['number'], ['title', 'body', 'addLabels', 'removeLabels', 'state'])(input); number(input.number); text(input.title, 'title', { max: 256, optional: true, multiline: false }); text(input.body, 'body', { max: 65_000, optional: true, min: 0 }); labels(input.addLabels); labels(input.removeLabels); oneOf(input.state, ['open', 'closed'], 'state', { optional: true }); return input; },
      input => input.state ? ['issue', input.state === 'closed' ? 'close' : 'reopen', String(input.number)] : ['issue', 'edit', String(input.number), ...(input.title ? ['--title', input.title] : []), ...bodyFile(input), ...(input.addLabels || []).flatMap(label => ['--add-label', label]), ...(input.removeLabels || []).flatMap(label => ['--remove-label', label])]),
    github_issue_comment: write(input => { repoInput(['number', 'body'])(input); number(input.number); text(input.body, 'body', { max: 65_000 }); return input; }, input => ['issue', 'comment', String(input.number), '--body-file', '-']),
    github_pr_create: write(input => { repoInput(['title'], ['body', 'base', 'head', 'draft'])(input); text(input.title, 'title', { max: 256, multiline: false }); text(input.body, 'body', { max: 65_000, optional: true, min: 0 }); pattern(input.base, BRANCH, 'base', { optional: true }); pattern(input.head, BRANCH, 'head', { optional: true }); bool(input.draft, 'draft'); return input; },
      input => ['pr', 'create', '--title', input.title, '--body-file', '-', ...(input.base ? ['--base', input.base] : []), ...(input.head ? ['--head', input.head] : []), ...(input.draft ? ['--draft'] : [])], { stdin: input => input.body ?? '' }),
    github_pr_update: write(input => { repoInput(['number'], ['title', 'body', 'base', 'addLabels'])(input); number(input.number); text(input.title, 'title', { max: 256, optional: true, multiline: false }); text(input.body, 'body', { max: 65_000, optional: true, min: 0 }); pattern(input.base, BRANCH, 'base', { optional: true }); labels(input.addLabels); return input; },
      input => ['pr', 'edit', String(input.number), ...(input.title ? ['--title', input.title] : []), ...bodyFile(input), ...(input.base ? ['--base', input.base] : []), ...(input.addLabels || []).flatMap(label => ['--add-label', label])]),
    github_pr_comment: write(input => { repoInput(['number', 'body'])(input); number(input.number); text(input.body, 'body', { max: 65_000 }); return input; }, input => ['pr', 'comment', String(input.number), '--body-file', '-']),
    github_pr_merge: write(input => { repoInput(['number'], ['method'])(input); number(input.number); oneOf(input.method, ['merge', 'squash', 'rebase'], 'method', { optional: true }); return input; }, input => ['pr', 'merge', String(input.number), `--${input.method || 'squash'}`], { stdin: () => null }),
    github_branch_delete: write(input => { repoInput(['branch'])(input); pattern(input.branch, BRANCH, 'branch'); return input; }, input => ['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${input.branch}`], { stdin: () => null })
  };
}

module.exports = { gitCapabilities, PROTECTED_BRANCHES, BRANCH, GIT_CANDIDATES, GH_CANDIDATES };
