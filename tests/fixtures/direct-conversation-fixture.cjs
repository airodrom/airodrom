'use strict';
// Synthetic text-only provider. Never contacts an installed service or model.
function conversationOptions() {
  return {
    qualify: async () => ({ state: 'READY', model: require('../../src/model-worker-router').MODEL }),
    request: async (_url, options) => {
      const messages = JSON.parse(options.body).messages;
      const prompt = messages.at(-1).content;
      const memory = messages.find(m => m.role === 'user' && m.content.startsWith('Current ordinary Memory V2 reference data'));
      const items = memory ? JSON.parse(memory.content.slice(memory.content.indexOf(': ') + 2)) : [];
      const content = /test codename/i.test(prompt) ? items.find(item => /test codename/i.test(item.content))?.content || 'unavailable' : 'fixture result';
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }));
    }
  };
}
module.exports = { conversationOptions };
