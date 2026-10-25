import mongoose from 'mongoose';
const { Schema, model, Types } = mongoose;
const ts = { timestamps: true };
export const ROLES = ['superadmin', 'admin', 'employee', 'client'];

/* ───────── Identidad y sesiones ───────── */
const UserSchema = new Schema({
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  name: String,
  avatar: String,
  role: { type: String, enum: ROLES, default: 'client', index: true },
  tenantId: { type: Types.ObjectId, ref: 'Tenant', index: true },
  passwordHash: { type: String, select: false },
  googleId: { type: String, index: { unique: true, sparse: true } },
  emailVerified: { type: Boolean, default: false },
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  lastLoginAt: Date,
  notificationPrefs: { email: { type: Boolean, default: true }, inApp: { type: Boolean, default: true } },
  // Verificación en dos pasos (TOTP) — obligatoria para el equipo
  mfa: {
    enabled: { type: Boolean, default: false }, enabledAt: Date,
    secretEnc: { type: String, select: false }, pendingSecretEnc: { type: String, select: false },
    backupCodes: { type: [String], select: false },
  },
}, ts);

// Sesión con caducidad ABSOLUTA de 30 días (no se renueva al usarla).
const SessionSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'User', index: true, required: true },
  refreshHash: { type: String, required: true, index: true },
  prevRefreshHash: String,              // detección de reutilización (robo de token)
  userAgent: String, ip: String, method: String,
  expiresAt: { type: Date, required: true },
  lastUsedAt: Date,
  revokedAt: Date,
}, ts);
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OtpSchema = new Schema({
  email: { type: String, index: true },
  purpose: { type: String, enum: ['login', 'verify', 'reset'] },
  codeHash: String,
  attempts: { type: Number, default: 0 },
  expiresAt: Date,
}, ts);
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* ───────── Tenants y planes ───────── */
const PlanSchema = new Schema({
  name: String, slug: { type: String, unique: true }, description: String,
  priceMonthly: { type: Number, default: 0 }, currency: { type: String, default: 'USD' },
  limits: {
    bots: { type: Number, default: 1 }, messagesPerMonth: { type: Number, default: 500 },
    mcpServers: { type: Number, default: 1 }, scheduledTasks: { type: Number, default: 2 },
    webhooks: { type: Number, default: 2 }, historyDays: { type: Number, default: 7 },
    apiKeys: { type: Number, default: 1 }, apiRequestsPerMinute: { type: Number, default: 60 },
    workflows: { type: Number, default: 3 }, functions: { type: Number, default: 1 }, contacts: { type: Number, default: 1000 },
  },
  features: [String], isPublic: { type: Boolean, default: true }, active: { type: Boolean, default: true }, order: Number,
}, ts);

const TenantSchema = new Schema({
  name: String, ownerId: { type: Types.ObjectId, ref: 'User' },
  subscription: {
    planId: { type: Types.ObjectId, ref: 'Plan' },
    status: { type: String, enum: ['trialing', 'active', 'past_due', 'canceled'], default: 'active' },
    currentPeriodStart: Date, currentPeriodEnd: Date,
  },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  // Juntial Center: identidad de la organización
  slug: { type: String, index: { unique: true, sparse: true } }, logo: String, country: String, timezone: { type: String, default: 'Europe/Madrid' },
}, ts);

const PlanRequestSchema = new Schema({
  tenantId: { type: Types.ObjectId, ref: 'Tenant', index: true }, requestedBy: Types.ObjectId,
  planId: { type: Types.ObjectId, ref: 'Plan' }, status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, note: String,
}, ts);

/* ───────── Bots ───────── */
const PlaybookSchema = new Schema({ name: String, when: String, steps: String, enabled: { type: Boolean, default: true } }, { _id: true });
const LeadFieldSchema = new Schema({ key: String, label: String, type: { type: String, enum: ['text', 'email', 'tel', 'textarea'], default: 'text' }, required: Boolean }, { _id: false });

const BotSchema = new Schema({
  tenantId: { type: Types.ObjectId, ref: 'Tenant', index: true, required: true },
  name: String,
  kind: { type: String, enum: ['telegram', 'web', 'worker'], default: 'telegram', index: true },
  // Procedimientos en lenguaje natural (marco agéntico): cuándo aplicarlos y qué pasos seguir
  playbooks: [PlaybookSchema],
  // Empleado digital (agente proactivo): puesto, manual, autonomía calibrada, informes y memoria aprendida
  worker: {
    role: String, title: String, mission: String, responsibilities: String, kpis: String,
    knowledge: { instructions: String, examples: [{ situation: String, action: String, _id: false }] },
    memory: [{ text: String, source: { type: String, enum: ['feedback', 'chat', 'agent', 'manual'] }, at: Date }],
    autonomy: {
      preset: { type: String, default: 'asistente' },
      policy: { read: { type: String, default: 'auto' }, internal: { type: String, default: 'auto' }, data: { type: String, default: 'approve' }, external: { type: String, default: 'approve' }, destructive: { type: String, default: 'off' } },
      toolOverrides: { type: Schema.Types.Mixed, default: {} },
      maxActionsPerRun: { type: Number, default: 15 }, maxRunsPerDay: { type: Number, default: 48 }, approvalTtlHours: { type: Number, default: 48 },
      workingHours: { enabled: { type: Boolean, default: true }, start: { type: String, default: '08:00' }, end: { type: String, default: '19:00' }, days: { type: [Number], default: [1, 2, 3, 4, 5] }, tz: { type: String, default: 'Europe/Madrid' } },
    },
    departmentId: { type: Types.ObjectId, ref: 'Department' }, // área a la que pertenece (para las políticas de aprobación)
    reporting: {
      notifyPanel: { type: Boolean, default: true }, onlyWhenRelevant: { type: Boolean, default: true },
      telegramBotId: Types.ObjectId, chatId: Number,                                   // opcional
      email: { enabled: { type: Boolean, default: false }, to: [String], events: { type: [String], default: ['approvals', 'reports', 'questions'] } },
      webhook: { enabled: { type: Boolean, default: false }, url: String, secretEnc: { type: String, select: false }, events: { type: [String], default: ['approvals', 'decisions', 'reports', 'questions'] } },
    },
    paused: { type: Boolean, default: false },
    // Cómo trata los documentos que recibe o encuentra (facturas, contratos, albaranes…)
    documents: {
      autoProcess: { type: Boolean, default: true },
      rules: [{ type: { type: String }, how: String, fields: [String], _id: false }],
      fallback: { type: String, default: 'Resume el documento, indica de qué tipo es y avísame si requiere alguna acción.' },
    },
  },
  // Agente incrustado en webs mediante <script>
  web: {
    publicKey: { type: String, index: { unique: true, sparse: true } },
    allowedOrigins: [String],
    appearance: {
      title: String, subtitle: { type: String, default: 'Normalmente responde al instante' }, avatarUrl: String,
      primaryColor: { type: String, default: '#0E7C86' }, position: { type: String, enum: ['right', 'left'], default: 'right' },
      theme: { type: String, enum: ['auto', 'light', 'dark'], default: 'auto' }, launcherLabel: String,
    },
    greeting: { type: String, default: '¡Hola! ¿En qué puedo ayudarte?' },
    suggestions: [String],
    leadForm: { enabled: { type: Boolean, default: false }, preChat: { type: Boolean, default: false }, title: { type: String, default: 'Déjanos tus datos' }, fields: [LeadFieldSchema] },
    handoff: { enabled: { type: Boolean, default: true }, message: { type: String, default: 'Te pongo en contacto con una persona del equipo. Te escribiremos lo antes posible.' }, telegram: { botId: Types.ObjectId, chatId: Number } },
    guardrails: { allowedTopics: String, blockedTopics: String, maxChars: { type: Number, default: 2000 }, visitorPerMinute: { type: Number, default: 15 } },
    voice: {
      enabled: { type: Boolean, default: true }, mode: { type: String, enum: ['browser', 'openai', 'elevenlabs'], default: 'browser' },
      voice: { type: String, default: 'coral' }, elevenVoiceId: String, language: { type: String, default: 'es-ES' },
      silenceMs: { type: Number, default: 800 }, bargeIn: { type: Boolean, default: true }, instructions: String,
      keyEnc: { type: String, select: false }, keyMask: String,
    },
    mcpAck: { at: Date, by: String },
  },
  telegram: {
    tokenEnc: { type: String, select: false }, tokenMask: String,
    botId: Number, username: String, webhookSecretHash: { type: String, select: false },
    connected: { type: Boolean, default: false }, lastError: String,
  },
  ai: {
    provider: { type: String, enum: ['anthropic', 'openai'], default: 'anthropic' },
    model: String, apiKeyEnc: { type: String, select: false }, apiKeyMask: String,
    transcribeKeyEnc: { type: String, select: false },
    temperature: { type: Number, default: 0.4 }, maxTokens: { type: Number, default: 1500 }, maxToolSteps: { type: Number, default: 8 },
    autoUpgrade: { type: Boolean, default: true }, // si el modelo se retira, pasar a la versión más reciente de su familia
    modelStatus: { checkedAt: Date, available: Boolean, newer: String },
  },
  systemPrompt: { type: String, default: 'Eres un asistente útil y conciso.' },
  behavior: {
    groupMode: { type: String, enum: ['mention', 'always', 'commands'], default: 'mention' },
    triggerKeywords: [String],
    progressMessages: { type: Boolean, default: true },
    learnFromGroup: { type: Boolean, default: true },     // guarda contexto aunque no le hablen
    historyTurns: { type: Number, default: 20 },
    allowedChatIds: [Number],                             // vacío = todos
    language: { type: String, default: 'es' },
    buttons: {
      agent: { type: Boolean, default: true },                       // el agente puede generar botones
      menu: { enabled: { type: Boolean, default: false }, buttons: [String] }, // menú fijo en chats privados
      sets: [{ name: String, when: String, buttons: [String], _id: false }], // conjuntos predefinidos
    },
  },
  flood: {
    perChatPerMinute: { type: Number, default: 20 }, maxPending: { type: Number, default: 15 }, debounceMs: { type: Number, default: 1200 },
  },
  mcpServerIds: [{ type: Types.ObjectId, ref: 'McpServer' }],
  crm: { enabled: { type: Boolean, default: true } }, // el agente puede leer y rellenar la ficha del contacto
  status: { type: String, enum: ['active', 'paused', 'error'], default: 'paused', index: true },
  stats: { messagesIn: { type: Number, default: 0 }, messagesOut: { type: Number, default: 0 }, lastActivityAt: Date },
}, ts);

const McpServerSchema = new Schema({
  tenantId: { type: Types.ObjectId, ref: 'Tenant', index: true }, name: String, slug: String,
  url: String, transport: { type: String, enum: ['auto', 'streamable-http', 'sse'], default: 'auto' },
  authType: { type: String, enum: ['none', 'bearer', 'api_key', 'basic', 'headers', 'oauth2_code', 'oauth2_client_credentials'], default: 'none' },
  // Todo lo sensible va cifrado en un solo blob JSON
  credentialsEnc: { type: String, select: false },
  oauth: {
    authorizationUrl: String, tokenUrl: String, registrationUrl: String, clientId: String,
    scopes: String, connected: { type: Boolean, default: false }, expiresAt: Date,
  },
  toolAllowlist: [String],
  enabled: { type: Boolean, default: true },
  lastCheck: { ok: Boolean, at: Date, error: String, toolCount: Number },
}, ts);

/* ───────── Contexto de chats y mensajes ───────── */
const ChatContextSchema = new Schema({
  botId: { type: Types.ObjectId, ref: 'Bot', index: true }, tenantId: Types.ObjectId,
  chatId: Number, type: String, title: String, username: String,
  project: { name: String, code: String, description: String, crmRef: String },
  notes: [{ text: String, at: Date, by: String }],          // memoria que el bot guarda
  summary: String,                                           // resumen rodante
  participants: [{ id: Number, name: String, lastSeen: Date }],
  muted: { type: Boolean, default: false },
  lastMessageAt: Date,
}, ts);
ChatContextSchema.index({ botId: 1, chatId: 1 }, { unique: true });

const MessageSchema = new Schema({
  botId: { type: Types.ObjectId, index: true }, chatId: Number, threadId: Number,
  role: { type: String, enum: ['user', 'assistant', 'context'] },
  from: { id: Number, name: String }, text: String, media: [String],
  tgMessageId: Number, tokens: { in: Number, out: Number },
  expiresAt: Date,
}, { timestamps: true });
MessageSchema.index({ botId: 1, chatId: 1, createdAt: -1 });
MessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* ───────── Tareas y webhooks ───────── */
const TaskSchema = new Schema({
  tenantId: { type: Types.ObjectId, index: true }, botId: { type: Types.ObjectId, ref: 'Bot', index: true },
  name: String, type: { type: String, enum: ['cron', 'once'], default: 'cron' },
  cron: String, runAt: Date, timezone: { type: String, default: 'Europe/Madrid' },
  action: { type: String, enum: ['agent', 'message'], default: 'agent' },
  prompt: String, chatIds: [Number], enabled: { type: Boolean, default: true },
  createdBy: { type: String, default: 'user' },   // user | bot
  lastRunAt: Date, lastStatus: String, lastError: String, runs: { type: Number, default: 0 },
}, ts);

const WebhookSchema = new Schema({
  tenantId: { type: Types.ObjectId, index: true }, botId: { type: Types.ObjectId, ref: 'Bot', index: true },
  name: String, direction: { type: String, enum: ['inbound', 'outbound'] },
  // inbound
  tokenHash: { type: String, index: true }, action: { type: String, enum: ['send_message', 'run_agent'], default: 'send_message' },
  template: String, chatIds: [Number],
  // outbound
  url: String, events: [String], secretEnc: { type: String, select: false },
  enabled: { type: Boolean, default: true }, consecutiveFailures: { type: Number, default: 0 }, lastDeliveryAt: Date,
}, ts);

const WebhookDeliverySchema = new Schema({
  webhookId: { type: Types.ObjectId, index: true }, event: String, status: Number, ok: Boolean,
  attempt: Number, durationMs: Number, error: String, expiresAt: Date,
}, ts);
WebhookDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* ───────── Soporte ───────── */
const TicketSchema = new Schema({
  tenantId: { type: Types.ObjectId, index: true }, createdBy: { type: Types.ObjectId, ref: 'User' },
  subject: String, category: { type: String, enum: ['technical', 'billing', 'feature', 'other'], default: 'technical' },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  status: { type: String, enum: ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'], default: 'open', index: true },
  channel: { type: String, enum: ['ticket', 'chat'], default: 'ticket' },
  assignee: { type: Types.ObjectId, ref: 'User' }, lastMessageAt: Date, unreadForStaff: { type: Boolean, default: true },
}, ts);
const TicketMessageSchema = new Schema({
  ticketId: { type: Types.ObjectId, index: true }, authorId: { type: Types.ObjectId, ref: 'User' },
  authorRole: String, authorName: String, body: String, internal: { type: Boolean, default: false },
}, ts);

/* ───────── Notificaciones, uso, auditoría, logs ───────── */
const NotificationSchema = new Schema({
  userId: { type: Types.ObjectId, index: true }, type: String, title: String, body: String, link: String,
  severity: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' }, readAt: Date,
  expiresAt: Date,
}, ts);
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

const UsageSchema = new Schema({ tenantId: Types.ObjectId, period: String, messages: { type: Number, default: 0 }, tokensIn: Number, tokensOut: Number, warned80: Boolean, warned100: Boolean }, ts);
UsageSchema.index({ tenantId: 1, period: 1 }, { unique: true });

const AuditSchema = new Schema({
  actorId: Types.ObjectId, actorEmail: String, actorRole: String, tenantId: Types.ObjectId,
  action: String, target: { kind: String, id: String }, meta: Schema.Types.Mixed, ip: String, requestId: String,
  expiresAt: Date,
}, { timestamps: true });
AuditSchema.index({ createdAt: -1 });
AuditSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const BotLogSchema = new Schema({
  botId: { type: Types.ObjectId, index: true }, level: String, event: String, chatId: Number, message: String, meta: Schema.Types.Mixed,
  traceId: String, source: String, elapsedMs: Number, expiresAt: Date,
}, { timestamps: true });
BotLogSchema.index({ botId: 1, createdAt: -1 });
BotLogSchema.index({ botId: 1, traceId: 1 });
BotLogSchema.index({ botId: 1, level: 1, createdAt: -1 });
BotLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* ───────── API pública (claves, registro de peticiones, webhooks de plataforma) ───────── */
const ApiKeySchema = new Schema({
  kind: { type: String, enum: ['client', 'admin'], index: true },
  ownerId: { type: Types.ObjectId, ref: 'User', index: true }, tenantId: { type: Types.ObjectId, ref: 'Tenant', index: true },
  name: String, prefix: String, last4: String, hash: { type: String, unique: true },
  scopes: [String], ipAllowlist: [String], rateLimitPerMin: Number,
  expiresAt: Date, revokedAt: Date, lastUsedAt: Date, lastUsedIp: String, requests: { type: Number, default: 0 },
}, ts);

const ApiRequestLogSchema = new Schema({
  keyId: { type: Types.ObjectId, index: true }, tenantId: Types.ObjectId, method: String, path: String,
  status: Number, ms: Number, ip: String, requestId: String, expiresAt: Date,
}, { timestamps: true });
ApiRequestLogSchema.index({ keyId: 1, createdAt: -1 });
ApiRequestLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PlatformWebhookSchema = new Schema({
  name: String, url: String, events: [String], secretEnc: { type: String, select: false },
  createdBy: Types.ObjectId, enabled: { type: Boolean, default: true }, consecutiveFailures: { type: Number, default: 0 }, lastDeliveryAt: Date,
}, ts);

/* ───────── Conversaciones de agentes web ───────── */
const WebConversationSchema = new Schema({
  botId: { type: Types.ObjectId, index: true }, tenantId: Types.ObjectId, visitorId: String,
  messages: [{ role: String, text: String, images: Number, voice: Boolean, at: Date, _id: false }],
  lead: { name: String, email: String, phone: String, company: String, notes: String, extra: Schema.Types.Mixed, at: Date },
  handoff: { requested: Boolean, reason: String, summary: String, at: Date },
  meta: { url: String, title: String, referrer: String, userAgent: String, lang: String, ipHash: String },
  recordId: { type: Types.ObjectId, ref: 'CrmRecord' },
  messageCount: { type: Number, default: 0 }, lastMessageAt: Date, expiresAt: Date,
}, ts);
WebConversationSchema.index({ botId: 1, lastMessageAt: -1 });
WebConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const WebConversation = model('WebConversation', WebConversationSchema);

/* ───────── CRM: campos, contactos, actividad, reglas de flujo y funciones ───────── */
const FieldDefSchema = new Schema({
  tenantId: { type: Types.ObjectId, index: true }, module: { type: String, default: 'contacts' },
  key: String, label: String,
  type: { type: String, enum: ['text', 'textarea', 'email', 'phone', 'number', 'currency', 'boolean', 'date', 'datetime', 'picklist', 'multiselect', 'url'] },
  options: [String], required: Boolean, system: Boolean, order: Number,
  agentWritable: { type: Boolean, default: true }, aiHint: String, // el agente puede rellenarlo y cómo
}, ts);
FieldDefSchema.index({ tenantId: 1, module: 1, key: 1 }, { unique: true });

const CrmRecordSchema = new Schema({
  tenantId: { type: Types.ObjectId, index: true }, module: { type: String, default: 'contacts' },
  data: { type: Schema.Types.Mixed, default: {} },
  channels: { telegram: { botId: Types.ObjectId, userId: Number, chatId: Number, username: String }, web: { botId: Types.ObjectId, conversationId: Types.ObjectId } },
  agentIds: [{ type: Types.ObjectId, ref: 'Bot' }], createdBy: String,
}, { ...ts, minimize: false });
CrmRecordSchema.index({ tenantId: 1, updatedAt: -1 });
CrmRecordSchema.index({ tenantId: 1, 'data.email': 1 });
CrmRecordSchema.index({ tenantId: 1, 'channels.telegram.userId': 1 });

const CrmActivitySchema = new Schema({
  recordId: { type: Types.ObjectId, index: true }, tenantId: Types.ObjectId,
  type: { type: String, enum: ['created', 'updated', 'workflow', 'function', 'note', 'deleted'] },
  by: String, agentId: Types.ObjectId, changes: Schema.Types.Mixed, text: String, expiresAt: Date,
}, { timestamps: true });
CrmActivitySchema.index({ recordId: 1, createdAt: -1 });
CrmActivitySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const WorkflowSchema = new Schema({
  tenantId: { type: Types.ObjectId, index: true }, module: { type: String, default: 'contacts' },
  name: String, description: String, enabled: { type: Boolean, default: true }, order: { type: Number, default: 0 },
  scope: { type: { type: String, enum: ['all', 'agents'], default: 'all' }, agentIds: [{ type: Types.ObjectId, ref: 'Bot' }] },
  trigger: {
    event: { type: String, enum: ['create', 'edit', 'create_or_edit', 'field_update', 'delete', 'date'], default: 'create_or_edit' },
    fields: [String], repeat: { type: Boolean, default: false }, // false = solo cuando PASA a cumplir las condiciones
    dateField: String, offsetMinutes: { type: Number, default: 0 },
  },
  conditions: { match: { type: String, enum: ['all', 'any'], default: 'all' }, rules: [{ field: String, op: String, value: Schema.Types.Mixed, _id: false }] },
  actions: [{ type: { type: String, enum: ['email', 'telegram', 'webhook', 'field_update', 'notify', 'function', 'agent_task'] }, config: Schema.Types.Mixed, delayMinutes: { type: Number, default: 0 } }],
  webhookSecretEnc: { type: String, select: false },
  stats: { runs: { type: Number, default: 0 }, errors: { type: Number, default: 0 }, lastRunAt: Date },
}, ts);

const WorkflowRunSchema = new Schema({
  tenantId: Types.ObjectId, ruleId: { type: Types.ObjectId, index: true }, recordId: { type: Types.ObjectId, index: true },
  event: String, by: String, status: { type: String, enum: ['ok', 'partial', 'error', 'scheduled'] },
  actions: [{ type: { type: String }, status: String, error: String, ms: Number, _id: false }], expiresAt: Date,
}, { timestamps: true });
WorkflowRunSchema.index({ ruleId: 1, createdAt: -1 });
WorkflowRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const CrmFunctionSchema = new Schema({
  tenantId: { type: Types.ObjectId, index: true }, name: String, apiName: String, description: String,
  code: String, envEnc: { type: String, select: false }, envKeys: [String], timeoutMs: { type: Number, default: 10000 },
  testCases: [{ name: String, record: Schema.Types.Mixed, _id: false }], version: { type: Number, default: 1 },
  stats: { runs: { type: Number, default: 0 }, errors: { type: Number, default: 0 }, lastRunAt: Date },
}, ts);
CrmFunctionSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });

const FunctionRunSchema = new Schema({
  functionId: { type: Types.ObjectId, index: true }, tenantId: Types.ObjectId, recordId: Types.ObjectId, ruleId: Types.ObjectId,
  status: String, ms: Number, logs: Schema.Types.Mixed, trace: Schema.Types.Mixed, errorAt: Schema.Types.Mixed, input: String, result: Schema.Types.Mixed, error: String, trigger: String, expiresAt: Date,
}, { timestamps: true });
FunctionRunSchema.index({ functionId: 1, createdAt: -1 });
FunctionRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const FunctionVersionSchema = new Schema({ functionId: { type: Types.ObjectId, index: true }, version: Number, code: String, savedBy: String }, { timestamps: true });
export const FunctionVersion = model('FunctionVersion', FunctionVersionSchema);
export const FieldDef = model('FieldDef', FieldDefSchema);
export const CrmRecord = model('CrmRecord', CrmRecordSchema);
export const CrmActivity = model('CrmActivity', CrmActivitySchema);
export const Workflow = model('Workflow', WorkflowSchema);
export const WorkflowRun = model('WorkflowRun', WorkflowRunSchema);
export const CrmFunction = model('CrmFunction', CrmFunctionSchema);
export const FunctionRun = model('FunctionRun', FunctionRunSchema);

/* ───────── Empleado digital: rutinas, documentos, ejecuciones, aprobaciones y chat ───────── */
const WorkerRoutineSchema = new Schema({
  tenantId: { type: Types.ObjectId, index: true }, botId: { type: Types.ObjectId, index: true },
  name: String, cron: String, timezone: { type: String, default: 'Europe/Madrid' }, instruction: String,
  enabled: { type: Boolean, default: true }, system: String, // 'digest' = informe diario automático
  lastRunAt: Date, lastStatus: String, runs: { type: Number, default: 0 },
}, ts);
const WorkerDocSchema = new Schema({
  tenantId: Types.ObjectId, botId: { type: Types.ObjectId, index: true }, title: String, source: String,
  chunks: [{ i: Number, text: String, _id: false }], chars: Number,
}, ts);
const WorkerRunSchema = new Schema({
  tenantId: Types.ObjectId, botId: { type: Types.ObjectId, index: true },
  trigger: { type: { type: String }, label: String, ref: String }, instruction: String,
  status: { type: String, enum: ['running', 'done', 'waiting', 'error', 'skipped'], default: 'running' },
  summary: String, steps: [{ t: Number, kind: String, name: String, category: String, policy: String, args: Schema.Types.Mixed, result: String, ms: Number, _id: false }],
  approvals: Number, actions: Number, usage: Schema.Types.Mixed, ms: Number, endedAt: Date, expiresAt: Date,
  report: { sent: Boolean, noNews: Boolean, reason: String, delivery: [{ channel: String, ok: Boolean, info: String, error: String, _id: false }] },
}, ts);
WorkerRunSchema.index({ botId: 1, createdAt: -1 });
WorkerRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const WorkerApprovalSchema = new Schema({
  tenantId: Types.ObjectId, botId: { type: Types.ObjectId, index: true }, runId: Types.ObjectId,
  tool: String, label: String, category: String, args: Schema.Types.Mixed, reason: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'expired', 'executed', 'failed'], default: 'pending', index: true },
  decidedBy: String, decidedVia: String, decidedAt: Date, feedback: String, result: String, expiresAt: Date, tg: { botId: Types.ObjectId, chatId: Number, messageId: Number },
  tokenHash: { type: String, index: true, select: false }, channels: [String], // enlace firmado de decisión (email, webhook, página pública)
  // Aprobación avanzada (Juntial Center): política, cadena de pasos y decisiones por persona
  policyId: Types.ObjectId, policyName: String, departmentId: Types.ObjectId, amount: Number, currentStep: { type: Number, default: 0 },
  steps: [{ name: String, mode: String, quorum: Number, approverIds: [Types.ObjectId], status: { type: String, default: 'waiting' }, startedAt: Date, dueAt: Date, onTimeout: String, escalate: Schema.Types.Mixed, timeoutHours: Number, reminded: Number, _id: false,
    decisions: [{ memberId: Types.ObjectId, name: String, email: String, decision: String, via: String, comment: String, at: Date, _id: false }] }],
  approverTokens: { type: [{ memberId: Types.ObjectId, hash: String, _id: false }], select: false },
}, ts);
WorkerApprovalSchema.index({ botId: 1, status: 1, createdAt: -1 });
const WorkerMessageSchema = new Schema({ botId: { type: Types.ObjectId, index: true }, userId: Types.ObjectId, role: String, text: String, runId: Types.ObjectId, expiresAt: Date }, { timestamps: true });
WorkerMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const WorkerFileSchema = new Schema({
  tenantId: Types.ObjectId, botId: { type: Types.ObjectId, index: true },
  name: String, mime: String, size: Number, source: { type: String, enum: ['upload', 'url', 'connector', 'api', 'chat'] }, url: String,
  data: { type: Buffer, select: false }, note: String, recordId: Types.ObjectId,
  status: { type: String, enum: ['new', 'processing', 'analyzed', 'processed', 'ignored', 'error'], default: 'new', index: true },
  analysis: { documentType: String, matchedRule: String, summary: String, fields: Schema.Types.Mixed, confidence: Number, issues: [String], suggestedActions: [String], language: String, analyzedAt: Date },
  error: String, runIds: [Types.ObjectId], expiresAt: Date,
}, ts);
WorkerFileSchema.index({ botId: 1, createdAt: -1 });
WorkerFileSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const WorkerFile = model('WorkerFile', WorkerFileSchema);
export const WorkerRoutine = model('WorkerRoutine', WorkerRoutineSchema);
export const WorkerDoc = model('WorkerDoc', WorkerDocSchema);
export const WorkerRun = model('WorkerRun', WorkerRunSchema);
export const WorkerApproval = model('WorkerApproval', WorkerApprovalSchema);
export const WorkerMessage = model('WorkerMessage', WorkerMessageSchema);

/* ───────── Juntial Center: organizaciones, miembros, áreas, apps, conexiones, eventos y aprobaciones ───────── */
const MembershipSchema = new Schema({
  orgId: { type: Types.ObjectId, ref: 'Tenant', index: true }, userId: { type: Types.ObjectId, ref: 'User', index: true },
  email: { type: String, lowercase: true, trim: true }, name: String, title: String,
  orgRole: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
  departmentIds: [{ type: Types.ObjectId, ref: 'Department' }], managerId: { type: Types.ObjectId, ref: 'Membership' },
  appRoles: { type: Schema.Types.Mixed, default: {} }, // { juntialagents: 'admin' | 'editor' | 'viewer' | 'none' }
  telegramUsername: { type: String, lowercase: true, trim: true }, // para decidir aprobaciones desde Telegram
  status: { type: String, enum: ['active', 'disabled'], default: 'active' }, joinedAt: Date,
}, ts);
MembershipSchema.index({ orgId: 1, userId: 1 }, { unique: true });
const DepartmentSchema = new Schema({
  orgId: { type: Types.ObjectId, index: true }, name: String, description: String, color: { type: String, default: '#0E7C86' },
  parentId: { type: Types.ObjectId, ref: 'Department' }, headId: { type: Types.ObjectId, ref: 'Membership' },
}, ts);
const InvitationSchema = new Schema({
  orgId: { type: Types.ObjectId, index: true }, email: { type: String, lowercase: true, trim: true }, tokenHash: { type: String, index: true },
  orgRole: { type: String, default: 'member' }, departmentIds: [Types.ObjectId], appRoles: Schema.Types.Mixed, title: String,
  invitedBy: Types.ObjectId, acceptedAt: Date, expiresAt: Date,
}, ts);
InvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const OrgAppSchema = new Schema({ orgId: { type: Types.ObjectId, index: true }, appId: String, enabled: { type: Boolean, default: true }, settings: Schema.Types.Mixed, enabledBy: Types.ObjectId }, ts);
OrgAppSchema.index({ orgId: 1, appId: 1 }, { unique: true });
const OrgConnectionSchema = new Schema({
  orgId: { type: Types.ObjectId, index: true }, name: String, slug: String, service: String, description: String,
  type: { type: String, enum: ['api_key', 'bearer', 'basic', 'headers', 'oauth2_client_credentials'] },
  baseUrl: String, credentialsEnc: { type: String, select: false }, apps: [String], createdBy: Types.ObjectId, lastUsedAt: Date, uses: { type: Number, default: 0 },
}, ts);
OrgConnectionSchema.index({ orgId: 1, slug: 1 }, { unique: true });
const CenterEventSchema = new Schema({ orgId: { type: Types.ObjectId, index: true }, app: String, type: { type: String, index: true }, actor: String, data: Schema.Types.Mixed, expiresAt: Date }, { timestamps: true });
CenterEventSchema.index({ orgId: 1, createdAt: -1 });
CenterEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const CenterSubscriptionSchema = new Schema({ orgId: { type: Types.ObjectId, index: true }, name: String, events: [String], url: String, secretEnc: { type: String, select: false }, enabled: { type: Boolean, default: true }, failures: { type: Number, default: 0 }, lastDeliveryAt: Date }, ts);
const ApproverSpec = { kind: { type: String, enum: ['members', 'role', 'department', 'department_head'] }, memberIds: [Types.ObjectId], orgRoles: [String], appRoles: [String], departmentIds: [Types.ObjectId], _id: false };
const ApprovalPolicySchema = new Schema({
  orgId: { type: Types.ObjectId, index: true }, name: String, description: String, enabled: { type: Boolean, default: true }, priority: { type: Number, default: 100 },
  match: { app: { type: String, default: 'juntialagents' }, agentIds: [Types.ObjectId], departmentIds: [Types.ObjectId], categories: [String], toolPattern: String, minAmount: Number, _id: false },
  steps: [{ name: String, approvers: ApproverSpec, mode: { type: String, enum: ['any', 'all', 'quorum'], default: 'any' }, quorum: { type: Number, default: 2 }, timeoutHours: { type: Number, default: 24 }, onTimeout: { type: String, enum: ['remind', 'escalate', 'approve', 'reject'], default: 'remind' }, escalate: ApproverSpec, _id: false }],
}, ts);
export const Membership = model('Membership', MembershipSchema);
export const Department = model('Department', DepartmentSchema);
export const Invitation = model('Invitation', InvitationSchema);
export const OrgApp = model('OrgApp', OrgAppSchema);
export const OrgConnection = model('OrgConnection', OrgConnectionSchema);
export const CenterEvent = model('CenterEvent', CenterEventSchema);
export const CenterSubscription = model('CenterSubscription', CenterSubscriptionSchema);
export const ApprovalPolicy = model('ApprovalPolicy', ApprovalPolicySchema);

/* ───────── OAuth 2.1 (MCP para Claude, ChatGPT y otras apps de IA) ───────── */
const OAuthClientSchema = new Schema({ clientId: { type: String, unique: true }, secretHash: String, name: String, uri: String, logoUri: String, redirectUris: [String], grantTypes: [String], authMethod: String, softwareId: String, lastUsedAt: Date }, ts);
const OAuthGrantSchema = new Schema({
  clientId: { type: String, index: true }, userId: { type: Types.ObjectId, index: true }, orgId: Types.ObjectId, scopes: [String], resource: String,
  accessHash: { type: String, index: true }, accessExp: Date, refreshHash: { type: String, index: true }, refreshExp: Date, revokedAt: Date, lastUsedAt: Date, ip: String,
}, ts);
export const OAuthClient = model('OAuthClient', OAuthClientSchema);
export const OAuthGrant = model('OAuthGrant', OAuthGrantSchema);

export const ApiKey = model('ApiKey', ApiKeySchema);
export const ApiRequestLog = model('ApiRequestLog', ApiRequestLogSchema);
export const PlatformWebhook = model('PlatformWebhook', PlatformWebhookSchema);
export const User = model('User', UserSchema);
export const Session = model('Session', SessionSchema);
export const Otp = model('Otp', OtpSchema);
export const Plan = model('Plan', PlanSchema);
export const Tenant = model('Tenant', TenantSchema);
export const PlanRequest = model('PlanRequest', PlanRequestSchema);
export const Bot = model('Bot', BotSchema);
export const McpServer = model('McpServer', McpServerSchema);
export const ChatContext = model('ChatContext', ChatContextSchema);
export const Message = model('Message', MessageSchema);
export const Task = model('Task', TaskSchema);
export const Webhook = model('Webhook', WebhookSchema);
export const WebhookDelivery = model('WebhookDelivery', WebhookDeliverySchema);
export const Ticket = model('Ticket', TicketSchema);
export const TicketMessage = model('TicketMessage', TicketMessageSchema);
export const Notification = model('Notification', NotificationSchema);
export const Usage = model('Usage', UsageSchema);
export const Audit = model('Audit', AuditSchema);
export const BotLog = model('BotLog', BotLogSchema);

export const daysFromNow = (d) => new Date(Date.now() + d * 86400000);
