'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  let token = fragment.get('token') || '';
  try {
    if (token) sessionStorage.setItem('piBridgeToken', token);
    else token = sessionStorage.getItem('piBridgeToken') || '';
  } catch { /* This tab can still use the launch token without persistent storage. */ }
  if (fragment.has('token')) history.replaceState(null, '', window.location.pathname + window.location.search);

  let state = null;
  let selectedId = null;
  try { selectedId = sessionStorage.getItem('piBridgeTask'); } catch { /* Selection is optional. */ }
  let polling = false;
  let online = false;
  let memoryRequest = 0;
  let bannerTimer;
  const pending = new Set();
  const statusNames = { idle: 'Ready', queued: 'Queued', running: 'Working', starting: 'Starting', thinking: 'Working', running_tool: 'Taking action', compacting: 'Summarizing context', approval_required: 'Needs approval', approval_expired: 'Approval expired', awaiting_operator_grant: 'Awaiting operator grant', awaiting_mcp_continuation: 'Awaiting ChatGPT continuation', waiting_for_provider: 'Waiting for provider', waiting_for_operator: 'Waiting for your decision', waiting_for_agent: 'Waiting for agent', waiting_for_dependency: 'Waiting for dependency', completed: 'Turn complete · mission review pending', blocked: 'Blocked', paused: 'Paused', cancelled: 'Cancelled', error: 'Needs attention', failed: 'Needs attention', deadline: 'Time limit reached', stalled: 'May be stalled', interrupted: 'Interrupted' };
  const unsuccessfulStates = new Set(['failed', 'error', 'deadline', 'stalled', 'cancelled', 'interrupted', 'blocked', 'approval_expired', 'waiting_for_provider']);

  function taskNeedsAttention(current) {
    return current.safetyStop?.latched || current.stalled || ['failed', 'error', 'deadline', 'stalled'].includes(current.status);
  }

  function responseFor(current) {
    if (current.safetyStop?.latched) return { text: 'This task stopped at a safety boundary. Review the blocked action above. No completed response is available for this turn.', empty: true };
    if (current.busy) return { text: 'Pi is working. The completed response will appear here; follow its activity below.', empty: true };
    if (current.status === 'waiting_for_provider') return { text: 'This task is waiting for its reasoning provider. No completed response is available for this turn.', empty: true };
    if (unsuccessfulStates.has(current.status)) return { text: 'This turn ended without a completed response. Review the task status and any error above.', empty: true };
    return { text: current.lastResult || 'Send a message to begin or continue this task.', empty: !current.lastResult };
  }
  const activityNames = { agent_start: 'Pi started working', agent_end: 'Response finished', agent_settled: 'Task settled', turn_start: 'New step', turn_end: 'Step finished', message_start: 'Response started', message_end: 'Response updated', tool_execution_start: 'Action started', tool_execution_end: 'Action finished', compaction_start: 'Summarizing context', compaction_end: 'Context summary finished', extension_error: 'Safety extension reported an issue', auto_retry_start: 'Retry started', auto_retry_end: 'Retry finished' };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function text(id, value) { $(id).textContent = value; }
  function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—'; }
  function bytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
  }
  function time(value) {
    if (value == null) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }
  function elapsed(value) {
    if (value == null) return 'No reading yet';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (!Number.isFinite(seconds)) return 'No reading yet';
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  function task() { return state?.tasks?.find(item => item.id === selectedId); }
  function tell(message, error = false) {
    clearTimeout(bannerTimer);
    const banner = $('action-banner');
    banner.textContent = message;
    banner.className = `banner${error ? ' error' : ''}`;
    banner.hidden = false;
    if (!error) bannerTimer = setTimeout(() => { banner.hidden = true; }, 6500);
  }
  function connection(message, error = false) {
    const banner = $('connection-banner');
    banner.textContent = message;
    banner.className = `banner ${error ? 'error' : 'notice'}`;
    banner.hidden = false;
  }

  async function api(route, { method = 'GET', body, timeout = 15000 } = {}) {
    if (!token) throw new Error('Open the platform launch link to connect this page.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: 'omit', cache: 'no-store' });
      const raw = await response.text();
      let result;
      try { result = raw ? JSON.parse(raw) : {}; } catch { throw new Error('The platform returned an unreadable response.'); }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('Access was refused. Reopen the current platform launch link.');
        throw new Error(result.error || result.message || `The platform could not complete this request (${response.status}).`);
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The platform did not respond in time. Check its status and try again.');
      if (error instanceof TypeError) throw new Error('Cannot reach the local platform. Make sure it is running on this Mac.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function action(key, operation) {
    if (pending.has(key)) return;
    pending.add(key);
    renderControls();
    try { await operation(); } catch (error) { tell(error.message, true); }
    finally { pending.delete(key); renderControls(); }
  }

  function renderControls() {
    const current = task();
    const busy = current?.busy === true;
    const paused = current?.status === 'paused';
    const stopped = current?.safetyStop?.latched === true;
    const available = online && Boolean(token);
    const activeChat = current?.mission?.capabilityProfile === 'active-chat-local-ollama-smoke-v1';
    $('create-task-submit').disabled = !available || pending.has('create');
    $('send-prompt').disabled = !available || !current || busy || stopped || paused || current?.status === 'cancelled' || pending.has('prompt');
    $('send-prompt').textContent = pending.has('prompt') ? 'Sending…' : stopped ? 'Review safety stop' : busy ? 'Pi is working…' : 'Send to Pi ↑';
    $('pause-task').hidden = !busy;
    $('pause-task').disabled = !available || pending.has('pause');
    $('resume-task').hidden = !paused || stopped;
    $('resume-task').disabled = !available || pending.has('resume');
    $('resolve-stop').hidden = !stopped;
    $('resolve-stop').disabled = !available || busy || pending.has('resolve-stop');
    $('cancel-task').hidden = !busy && !paused && !activeChat;
    $('cancel-task').disabled = !available || pending.has('cancel');
    $('active-chat-initialize').disabled = !available || pending.has('active-authority');
    $('active-chat-authorize').disabled = !available || busy || pending.has('active-authorize');
    $('prompt-card').hidden = activeChat;
    $('save-memory-submit').disabled = !available || !current || pending.has('save-memory');
    $('read-web-submit').disabled = !available || !current || !state?.web?.enabled || Boolean(state?.web?.active) || pending.has('web');
    $('read-web-submit').textContent = pending.has('web') ? 'Reading…' : 'Read page ↗';
    $('new-task-button').disabled = !available;
    $('empty-new-task').disabled = !available;
    if (current) renderApprovals(current);
  }

  function selectTask(id) {
    if (selectedId === id) return;
    selectedId = id;
    try { sessionStorage.setItem('piBridgeTask', id); } catch { /* Selection is optional. */ }
    $('memory-query').value = '';
    $('prompt-message').value = '';
    $('web-result-details').hidden = true;
    $('action-banner').hidden = true;
    render();
    void loadMemory();
  }

  function renderTasks() {
    const tasks = state.tasks || [];
    text('task-count', tasks.length);
    const list = $('task-list');
    const nodes = tasks.map(item => {
      const button = node('button', `task-item${item.id === selectedId ? ' active' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-current', item.id === selectedId ? 'page' : 'false');
      button.append(node('span', 'task-item-title', item.description));
      const meta = node('span', 'task-item-meta');
      meta.append(node('span', `status-dot${taskNeedsAttention(item) ? ' error' : item.busy ? ' healthy' : ''}`), document.createTextNode(item.stalled ? 'May be stalled' : statusNames[item.status] || item.status));
      button.append(meta, node('span', 'task-item-meta', item.id.slice(0, 8)));
      button.addEventListener('click', () => selectTask(item.id));
      return button;
    });
    list.replaceChildren(...(nodes.length ? nodes : [node('p', 'sidebar-empty', 'Your tasks will appear here.')]));
  }

  function addFact(list, label, value) { list.append(node('dt', '', label), node('dd', '', value == null || value === '' ? '—' : value)); }

  function healthAge(ageMs) { return ageMs == null ? 'unknown' : `${Math.floor(ageMs / 1000)}s ago`; }

  function renderTask() {
    const current = task();
    $('empty-state').hidden = Boolean(current);
    $('workspace-layout').hidden = !current;
    if (!current) return;
    text('task-title', current.description);
    text('task-status', current.stalled ? 'May be stalled' : statusNames[current.status] || current.status);
    $('task-status').className = `badge${taskNeedsAttention(current) ? ' error' : ['approval_required', 'waiting_for_provider', 'waiting_for_operator'].includes(current.status) ? ' warning' : ''}`;
    text('heartbeat-value', current.health ? `${current.health.status} · ${current.health.score === null ? 'Unknown score' : current.health.score + '%'}` : current.heartbeatHealthy ? 'Healthy' : current.connected ? 'Delayed' : 'Not running');
    text('heartbeat-detail', current.health ? `Process: ${current.health.processState} · Lease: ${current.health.leaseState} · Elapsed: ${current.health.elapsedMs === null ? 'unknown' : Math.floor(current.health.elapsedMs / 1000) + 's'} · Budget: ${current.health.budgetMs === null ? 'unknown' : Math.floor(current.health.budgetMs / 1000) + 's'} · Phase: ${current.health.phase || 'unknown'} · Heartbeat: ${healthAge(current.health.heartbeatAgeMs)} · Event: ${healthAge(current.health.eventAgeMs)} · Output: ${healthAge(current.health.outputAgeMs)} · ${current.health.reasons.join(', ') || (current.health.active ? 'Monitoring' : 'No active run')}` : current.lastHeartbeatAt ? `Last pulse ${elapsed(current.lastHeartbeatAt)}` : 'Pi starts when you send a message');
    const context = current.context;
    text('context-value', typeof context?.percent === 'number' ? `${context.percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '—');
    $('context-progress').value = typeof context?.percent === 'number' ? Math.min(100, Math.max(0, context.percent)) : 0;
    text('context-detail', context ? `${number(context.tokens)} / ${number(context.contextWindow)} tokens` : 'Available after a model response');
    text('compactions-value', number(current.compactions));
    text('compactions-detail', current.lastCompaction ? `Latest ${elapsed(current.lastCompaction.at)}` : 'Session history summaries');
    const alert = $('task-alert');
    alert.hidden = !current.error && !current.stalled && !current.lastRunBlocked && !current.safetyStop?.latched;
    alert.textContent = current.safetyStop?.latched ? `SAFETY STOP LATCHED: ${current.safetyStop.reason} An authenticated operator must review and explicitly resolve this stop. No new session or tool can continue the mission.` : current.error || (current.lastRunBlocked ? 'An action was blocked before execution. Review its approval status below; the model response is not proof that the action ran.' : current.stalled ? 'No recent task activity. Pi may still be working; check the heartbeat or stop the task.' : '');
    const activeChat = current.mission?.capabilityProfile === 'active-chat-local-ollama-smoke-v1';
    $('active-chat-operator').hidden = !activeChat;
    if (activeChat) {
      const authority = current.missionAuthorization?.authority || {};
      const awaiting = current.status === 'awaiting_operator_grant';
      text('active-chat-state', awaiting ? authority.keyInitialized ? 'Ready for fixed grant' : 'Authority not initialized' : current.status === 'awaiting_mcp_continuation' ? 'Awaiting MCP continuation' : statusNames[current.status] || current.status);
      text('active-chat-description', awaiting ? authority.keyInitialized ? 'Review the fixed local-only scope in the task facts, then explicitly authorize its two turns. No task text or model output can issue this grant.' : 'Initialize the private local signing authority only after reviewing this task. This creates no grant and does not start Pi.' : 'This task can be continued only by its authenticated MCP connection after Task A settles. The Control Center cannot send a free-form turn.');
      $('active-chat-initialize').hidden = !awaiting || authority.keyInitialized === true;
      $('active-chat-authorize').hidden = !awaiting || authority.keyInitialized !== true;
    }
    const response = responseFor(current);
    text('last-response', response.text);
    $('last-response').className = `response-text${response.empty ? ' empty-copy' : ''}`;
    text('response-state', current.busy ? 'Live activity below' : current.lastActivityAt ? `Updated ${elapsed(current.lastActivityAt)}` : 'Ready when you are');
    const events = (current.events || []).slice(-12).reverse();
    text('activity-count', events.length ? `Latest ${events.length} events` : 'No events yet');
    $('activity-list').replaceChildren(...events.map(event => {
      const row = node('li', 'activity-row');
      const title = activityNames[event.type] || event.type.replaceAll('_', ' ');
      row.append(node('span', '', `${title}${event.toolName ? ` · ${event.toolName}` : ''}${event.isError ? ' · needs attention' : ''}`), node('time', '', time(event.at)));
      return row;
    }));
    text('prompt-hint', current.safetyStop?.latched ? 'Safety stop is latched. Resolve it as the local operator before continuing.' : current.status === 'paused' ? 'Mission is paused. Resume creates a fresh worker turn with the preserved objective and budgets.' : current.busy ? 'This task is running. Pause or cancel it before sending another message.' : 'Changes and shell commands require their exact authorization.');
    const facts = $('session-facts');
    facts.replaceChildren();
    addFact(facts, 'Task ID', current.id);
    addFact(facts, 'Session ID', current.sessionId);
    if (current.source?.transport === 'mcp') {
      addFact(facts, 'Request source', `MCP · ${current.source.client_reported?.name || 'Unknown client'} (client label is unverified)`);
      addFact(facts, 'Request nonce', current.latestMcpRequestId || current.source.request_id);
    }
    addFact(facts, 'Workspace', current.workspace);
    addFact(facts, 'Mission ID', current.mission?.id || current.id);
    addFact(facts, 'Mission acceptance', current.mission?.status || '—');
    if (current.missionAuthority) {
      addFact(facts, 'Mission authority', `${current.missionAuthority.label} · ${current.missionAuthority.status}`);
      addFact(facts, 'Authority expires', new Date(current.missionAuthority.expiresAt).toLocaleString());
      for (const [dimension, permissions] of Object.entries(current.missionAuthority.permissions)) addFact(facts, dimension, permissions.join(', ') || 'None');
      addFact(facts, 'Filesystem authority', `Read: ${current.missionAuthority.filesystem.read.join(', ') || 'None'} · Write: ${current.missionAuthority.filesystem.write.join(', ') || 'None'}`);
    }
    addFact(facts, 'Grant state', current.missionAuthorization?.status || 'inactive');
    addFact(facts, 'Grant scope', current.missionAuthorization?.enabled ? `${(current.missionAuthorization.capabilities || []).join(', ')} · ${current.missionAuthorization.egress}` : 'Live grants disabled');
    addFact(facts, 'Cumulative budget', current.mission?.budget ? `${Math.round((current.mission.used?.runtimeMs || 0) / 1000)}s / ${Math.round(current.mission.budget.maxRuntimeMs / 1000)}s · ${current.mission.used?.actions || 0} / ${current.mission.budget.maxActions} actions · ${current.mission.used?.retries || 0} / ${current.mission.budget.maxRetries} retries` : '—');
    if (current.previousSessionId) addFact(facts, 'Recovery lineage', `${current.previousSessionId} → ${current.sessionId}`);
    addFact(facts, 'Live autonomy', state?.bridge?.missionAutomation?.liveGrantsEnabled ? 'Enabled by operator' : 'Disabled · local simulations only');
    addFact(facts, 'Session file', current.sessionFile || 'Created when Pi starts');
    addFact(facts, 'Session storage', bytes(current.sessionBytes));
    addFact(facts, 'Last activity', time(current.lastActivityAt));
    addFact(facts, 'Context summaries', current.lastCompaction ? JSON.stringify(current.lastCompaction, null, 2) : 'None recorded');
    renderMemoryStatus(current);
  }

  function renderApprovals(current) {
    const approvals = (state.approvals || []).filter(item => item.taskId === current.id && ['pending', 'approved', 'expired'].includes(item.status));
    text('approval-count', `${approvals.filter(item => item.status === 'pending').length} waiting`);
    const children = approvals.map(approval => {
      const card = node('article', 'approval-item');
      const heading = node('div', 'approval-top');
      heading.append(node('span', '', approval.toolName), node('span', '', approval.status === 'approved' ? 'Approved · one use' : approval.status === 'expired' ? 'Expired · request again' : 'Review required'));
      card.append(heading, node('pre', '', JSON.stringify(approval.input, null, 2)));
      const details = node('div', 'approval-details');
      details.append(node('div', '', `Folder: ${approval.workspace}`), node('div', '', `Session: ${approval.sessionId}`), node('div', '', `Expires: ${time(approval.expiresAt)}`));
      card.append(details);
      const buttons = node('div', 'approval-actions');
      if (approval.status === 'pending') {
        const approve = node('button', 'button primary', 'Approve once & retry');
        approve.type = 'button';
        // A pending approval belongs to the approval, not to model activity.
        // The server queues its exact retry after the active turn settles.
        approve.disabled = pending.has(approval.id) || !online;
        approve.addEventListener('click', () => action(approval.id, async () => {
          approve.disabled = true;
          await api(`/api/approvals/${encodeURIComponent(approval.id)}/approve`, { method: 'POST', body: {} });
          tell('Approval granted. Pi will retry this exact action once.');
          await poll();
        }));
        buttons.append(approve);
      }
      const reject = node('button', 'button secondary', approval.status === 'approved' ? 'Revoke approval' : 'Reject');
      reject.type = 'button';
      reject.disabled = pending.has(approval.id) || !online;
      reject.addEventListener('click', () => action(approval.id, async () => {
        reject.disabled = true;
        await api(`/api/approvals/${encodeURIComponent(approval.id)}/reject`, { method: 'POST', body: {} });
        tell('Approval rejected. The action is not authorized.');
        await poll();
      }));
      buttons.append(reject);
      card.append(buttons);
      return card;
    });
    $('approvals-list').replaceChildren(...(children.length ? children : [node('div', 'approval-empty', 'No actions waiting for approval.')]));
  }

  function memoryCard(item) {
    const card = node('article', 'memory-item');
    const meta = node('div', 'memory-meta');
    meta.append(node('span', 'kind-pill', item.kind || 'Memory'), node('span', '', `${item.shared ? 'Shared · ' : ''}${elapsed(item.updatedAt || item.createdAt)}`));
    card.append(meta, node('p', 'memory-content', item.content));
    if (item.contentTruncated) card.append(node('p', 'memory-reason', 'Excerpt shown to stay within the retrieval budget.'));
    const provenance = item.provenance || {};
    const source = node('details', 'source-line');
    source.append(node('summary', '', `Source: ${provenance.source || 'Not recorded'}`));
    source.append(node('div', '', JSON.stringify(provenance, null, 2)));
    card.append(source);
    if (item.reason) card.append(node('p', 'memory-reason', item.reason));
    return card;
  }

  function renderMemoryStatus(current) {
    text('memory-total', `${number(state.memory?.count)} total`);
    text('memory-storage', `${bytes(state.memory?.dbBytes)} stored locally`);
    text('memory-scope', current.includeSharedMemory ? 'Task + shared memory' : 'This task only');
    const budget = current.retrievalBudget;
    text('retrieval-budget', budget ? `${number(budget.usedChars)} characters · ~${number(budget.estimatedTokens)} tokens${budget.truncated ? ' · budget limited' : ''}` : 'No memory retrieved yet.');
    const items = current.retrievedMemory || [];
    $('retrieved-memory-list').replaceChildren(...(items.length ? items.map(memoryCard) : [node('p', 'empty-copy', 'Only relevant memories are added to a request. None were used for this turn.')]));
  }

  async function loadMemory() {
    if (!selectedId || !online) return;
    const id = selectedId;
    const sequence = ++memoryRequest;
    text('memory-list', 'Loading memory…');
    try {
      const parameters = new URLSearchParams({ taskId: id, query: $('memory-query').value });
      const result = await api(`/api/memory?${parameters}`);
      if (selectedId !== id || sequence !== memoryRequest) return;
      const items = Array.isArray(result.items) ? result.items : [];
      $('memory-list').replaceChildren(...(items.length ? items.map(memoryCard) : [node('p', 'empty-copy', $('memory-query').value ? 'No matching memory for this task.' : 'No saved memory yet. Add a useful fact or decision below.')]));
    } catch (error) {
      if (selectedId === id && sequence === memoryRequest) $('memory-list').replaceChildren(node('p', 'empty-copy', error.message));
    }
  }

  function renderWeb() {
    const web = state.web;
    const enabled = web?.enabled === true;
    text('web-status', enabled ? web.active ? 'Reading' : 'Available' : 'Off');
    $('web-status').className = `badge${enabled ? '' : ' quiet'}`;
    text('web-description', enabled ? 'Read approved public pages. Access stays within the allowed sites and safety policy.' : 'Web reading is off. Enable it in the local platform configuration to use approved public sites.');
    $('web-hosts').replaceChildren(...(web?.allowedHosts || []).map(host => node('span', 'host-pill', host)));
    const latest = web?.lastFetch;
    text('web-last-fetch', web?.lastError ? `Last read: ${typeof web.lastError === 'string' ? web.lastError : web.lastError.message || 'Could not read the page'}` : latest ? `Last read: ${typeof latest === 'string' ? latest : latest.finalUrl || 'Page read'}` : 'No page read yet.');
  }

  function render() {
    if (!state) { renderControls(); return; }
    const healthy = online && state.bridge?.healthy === true;
    const connectionState = online ? state.bridge?.chatgptConnection?.state : 'not_connected';
    const connectionLabel = connectionState === 'connected' ? 'Connected' : connectionState === 'degraded' ? 'Degraded' : 'Not connected';
    text('chatgpt-status', connectionLabel);
    text('chatgpt-badge', `ChatGPT · ${connectionLabel}`);
    text('chatgpt-description', connectionState === 'connected' ? 'Outbound ChatGPT tunnel is live and its MCP channel is healthy.' : connectionState === 'degraded' ? 'Tunnel is live, but its MCP channel is unavailable.' : 'Outbound ChatGPT tunnel is unavailable.');
    text('bridge-status', healthy ? `${globalThis.AirodromBranding.name} is healthy` : `${globalThis.AirodromBranding.name} unavailable`);
    $('bridge-dot').className = `status-dot ${healthy ? 'healthy' : 'error'}`;
    text('updated-at', `Updated ${time(state.bridge?.now || Date.now())}`);
    text('storage-summary', `${bytes(state.storage?.freeBytes)} free on this Mac`);
    renderTasks();
    renderTask();
    renderWeb();
    renderControls();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const result = await api('/api/state');
      if (!result.bridge || !Array.isArray(result.tasks)) throw new Error('The platform returned incomplete status.');
      state = result;
      online = true;
      $('connection-banner').hidden = true;
      const changedSelection = !state.tasks.some(item => item.id === selectedId);
      if (changedSelection) selectedId = state.tasks[0]?.id || null;
      render();
      if (changedSelection && selectedId) void loadMemory();
    } catch (error) {
      online = false;
      connection(error.message, true);
      text('chatgpt-status', 'Status unavailable');
      text('chatgpt-badge', 'ChatGPT · Status unavailable');
      text('chatgpt-description', 'Reconnect Control Center to check the outbound tunnel.');
      text('bridge-status', `${globalThis.AirodromBranding.name} unavailable`);
      $('bridge-dot').className = 'status-dot error';
      text('updated-at', state ? 'Showing last known status' : 'Not connected');
      if (!state) {
        text('task-count', '—');
        $('task-list').replaceChildren(node('p', 'sidebar-empty', 'Task list unavailable until Control Center reconnects.'));
      }
      renderControls();
    } finally { polling = false; }
  }

  function showNewTask() { $('new-task-panel').hidden = false; $('task-description').focus(); }
  $('new-task-button').addEventListener('click', showNewTask);
  $('empty-new-task').addEventListener('click', showNewTask);
  $('close-new-task').addEventListener('click', () => { $('new-task-panel').hidden = true; });

  $('new-task-form').addEventListener('submit', event => {
    event.preventDefault();
    void action('create', async () => {
      const workspace = $('task-workspace').value.trim();
      if (workspace && !workspace.startsWith('/')) throw new Error('Enter an absolute folder path starting with /.');
      const created = await api('/api/tasks', { method: 'POST', body: { description: $('task-description').value.trim(), ...(workspace ? { workspace } : {}), includeSharedMemory: $('task-shared-memory').checked } });
      selectedId = created.id;
      $('new-task-form').reset();
      $('new-task-panel').hidden = true;
      await poll();
      await loadMemory();
      tell('Task created. Send Pi its first instruction.');
      $('prompt-message').focus();
    });
  });

  $('prompt-form').addEventListener('submit', event => {
    event.preventDefault();
    const id = selectedId;
    const message = $('prompt-message').value.trim();
    if (!id || !message) return;
    void action('prompt', async () => {
      await api(`/api/tasks/${encodeURIComponent(id)}/prompt`, { method: 'POST', body: { message } });
      if (selectedId === id) $('prompt-message').value = '';
      tell('Message sent. Pi is working on this task.');
      await poll();
    });
  });

  $('active-chat-initialize').addEventListener('click', () => {
    void action('active-authority', async () => {
      if (!window.confirm('Initialize the protected local authority key? This does not issue a grant or start Pi.')) return;
      await api('/api/active-chat/authority/initialize', { method: 'POST', body: {} });
      tell('Protected authority initialized. Review the fixed scope before authorizing a grant.'); await poll();
    });
  });
  $('active-chat-authorize').addEventListener('click', () => {
    const id = selectedId; if (!id) return;
    void action('active-authorize', async () => {
      if (!window.confirm('Authorize exactly this fixed two-turn, read-only local-Qwen smoke? This starts Task A and cannot expand its scope.')) return;
      await api(`/api/tasks/${encodeURIComponent(id)}/active-chat/authorize`, { method: 'POST', body: {} });
      tell('Fixed grant issued. Task A has been dispatched through the brokered local model path.'); await poll();
    });
  });

  $('cancel-task').addEventListener('click', () => {
    const id = selectedId;
    if (!id) return;
    void action('cancel', async () => {
      await api(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
      tell('Mission cancelled. Unused approvals and fixture authority have been revoked.');
      await poll();
    });
  });
  $('pause-task').addEventListener('click', () => {
    const id = selectedId; if (!id) return;
    void action('pause', async () => { await api(`/api/tasks/${encodeURIComponent(id)}/pause`, { method: 'POST', body: {} }); tell('Mission paused.'); await poll(); });
  });
  $('resume-task').addEventListener('click', () => {
    const id = selectedId; if (!id) return;
    void action('resume', async () => { await api(`/api/tasks/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }); tell('Mission resuming with its preserved objective and budget.'); await poll(); });
  });
  $('resolve-stop').addEventListener('click', () => {
    const id = selectedId; if (!id) return;
    const rationale = window.prompt('Explain why you are resolving this safety stop. Review the blocked operation before continuing.');
    if (!rationale?.trim()) return;
    void action('resolve-stop', async () => { await api(`/api/tasks/${encodeURIComponent(id)}/resolve-stop`, { method: 'POST', body: { rationale: rationale.trim() } }); tell('Safety stop resolution recorded. You may now decide whether to continue.'); await poll(); });
  });

  function memoryTab(retrieved) {
    $('saved-tab').className = `tab${retrieved ? '' : ' active'}`;
    $('retrieved-tab').className = `tab${retrieved ? ' active' : ''}`;
    $('saved-tab').setAttribute('aria-selected', String(!retrieved));
    $('retrieved-tab').setAttribute('aria-selected', String(retrieved));
    $('saved-memory-panel').hidden = retrieved;
    $('retrieved-memory-panel').hidden = !retrieved;
  }
  $('saved-tab').addEventListener('click', () => memoryTab(false));
  $('retrieved-tab').addEventListener('click', () => memoryTab(true));
  for (const tab of [$('saved-tab'), $('retrieved-tab')]) tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const retrieved = event.key === 'End' || (event.key !== 'Home' && tab.id === 'saved-tab');
    memoryTab(retrieved);
    $(retrieved ? 'retrieved-tab' : 'saved-tab').focus();
  });
  $('memory-search-form').addEventListener('submit', event => { event.preventDefault(); void loadMemory(); });
  $('memory-query').addEventListener('search', () => { void loadMemory(); });
  $('memory-save-form').addEventListener('submit', event => {
    event.preventDefault();
    const id = selectedId;
    if (!id) return;
    void action('save-memory', async () => {
      await api('/api/memory', { method: 'POST', body: { taskId: id, kind: $('memory-kind').value, content: $('memory-content').value.trim(), shared: $('memory-shared').checked } });
      if (selectedId === id) { $('memory-save-form').reset(); memoryTab(false); await loadMemory(); }
      tell('Memory saved with this task as its source.');
      await poll();
    });
  });

  $('web-form').addEventListener('submit', event => {
    event.preventDefault();
    const id = selectedId;
    if (!id) return;
    void action('web', async () => {
      const result = await api(`/api/tasks/${encodeURIComponent(id)}/web`, { method: 'POST', body: { url: $('web-url').value.trim(), method: 'GET' }, timeout: 45000 });
      if (selectedId === id) {
        text('web-result', result.text || 'The page returned no readable text.');
        const source = result.provenance || {};
        text('web-result-source', `${source.finalUrl || 'Public page'} · ${time(source.fetchedAt)} · ${bytes(source.bytes)}${source.truncated ? ' · excerpt' : ''} · Untrusted reference`);
        $('web-result-details').hidden = false;
        $('web-result-details').open = true;
      }
      tell('Page read. Its contents and source are available below.');
      await poll();
    });
  });

  window.addEventListener('hashchange', () => {
    const next = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (!next || !/^[a-f0-9]{64}$/.test(next)) return;
    token = next;
    try { sessionStorage.setItem('piBridgeToken', token); } catch { /* Keep it only in this tab. */ }
    history.replaceState(null, '', window.location.pathname + window.location.search);
    void poll();
  });
  if (!token) connection('Open this page from the platform launch link to connect securely. No access token is present.');
  renderControls();
  void poll();
  setInterval(() => { if (token) void poll(); }, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) void poll(); });
})();
