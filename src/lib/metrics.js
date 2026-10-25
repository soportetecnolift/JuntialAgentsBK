import client from 'prom-client';
client.collectDefaultMetrics({ prefix: 'juntialagents_' });
export const registry = client.register;
export const httpDuration = new client.Histogram({ name: 'juntialagents_http_duration_seconds', help: 'HTTP', labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.3, 1, 3, 10] });
export const tgUpdates = new client.Counter({ name: 'juntialagents_tg_updates_total', help: 'Updates Telegram', labelNames: ['outcome'] });
export const tgDropped = new client.Counter({ name: 'juntialagents_tg_dropped_total', help: 'Mensajes descartados por flood', labelNames: ['reason'] });
export const llmLatency = new client.Histogram({ name: 'juntialagents_llm_seconds', help: 'Latencia LLM', labelNames: ['provider'], buckets: [0.5, 1, 2, 5, 10, 30, 60, 120] });
export const tgOut429 = new client.Counter({ name: 'juntialagents_tg_429_total', help: '429 de Telegram' });
export const agentStage = new client.Histogram({ name: 'juntialagents_agent_stage_seconds', help: 'Tiempo por etapa del agente', labelNames: ['stage'], buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10, 30, 60] });
