import events from './chatgpt-events.js';
export function registerChatGPTEventTool(pi, request) {
  let correlation = null;
  pi.on('before_agent_start', async () => { try { correlation = await request('/events/context', {}); } catch { correlation = null; } });
  pi.on('session_shutdown', async () => { correlation = null; });
  pi.registerTool({
    name: 'chatgpt_notify', label: 'Notify ChatGPT',
    description: 'Queue a concise event for the originating task. Optional operator-configured Workspace Agent trigger; otherwise ChatGPT polls its inbox. Never approves or executes follow-up requests. Omit names, paths and secrets. Reuse event_id with identical fields after uncertain delivery.',
    parameters: { type: 'object', properties: events.properties, required: ['event_id', 'event_type', 'summary'], additionalProperties: false },
    async execute(_id, input, signal) {
      if (!correlation) throw new Error('Event correlation is not ready');
      events.validateEvent(input);
      const response = await request('/events', { ...correlation, event: input }, signal);
      if(response?.allow===false)throw new Error('Event publication was denied');
      // Support both existing direct receipts and the broker response envelope.
      const raw=response?.allow===true?response.output:response;
      const result=typeof raw==='string'?JSON.parse(raw):raw;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    }
  });
}
