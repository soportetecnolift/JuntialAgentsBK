# JuntialAgents · Backend

API REST + workers para la plataforma de bots de Telegram con IA.
Node.js 20 · Express · MongoDB Atlas · Redis (BullMQ) · Socket.IO

Repositorio independiente del frontend ([juntialagents-frontend](../juntialagents-frontend)). Se comunican solo por HTTP/WebSocket, así que se despliegan y escalan por separado.

## Servicios

| Proceso | Comando | Escala |
|---|---|---|
| API | `npm run start:api` | Horizontal, sin estado (detrás de un balanceador) |
| Workers | `npm run start:worker` | Horizontal según la cola `chat-drain` |

## Superficies de API

| Prefijo | Para quién | Autenticación |
|---|---|---|
| `/api/*` | El frontend web | JWT de 15 min + refresh en cookie (sesión absoluta de 30 días) |
| `/v1/*` | **Integraciones de clientes** | API key `ja_live_ck_…` limitada a su cuenta |
| `/v1/admin/*` | **Desarrollos a medida de administradores** | API key `ja_live_ak_…` con alcance de plataforma |
| `/tg/:botId` | Telegram | `secret_token` del webhook |
| `/hooks/in/:token` | Sistemas externos | Token del webhook entrante |
| `/docs` | Desarrolladores | Documentación interactiva (Scalar) de `/v1/openapi.json` |

## Empleado digital (agente proactivo)

Es un tercer tipo de agente (`kind: 'worker'`) que trabaja por su cuenta como un empleado.

**Puesto**
- Plantillas: comercial, soporte, administración/cobros, operaciones, asistente de dirección o personalizado.
- Cada una trae misión, responsabilidades, KPIs y rutinas de partida. Las rutinas se crean en pausa para que el cliente las revise.

**Entrenamiento**
- Manual del puesto y ejemplos «si pasa… haz…».
- Documentos de texto o de una web, troceados y buscados con BM25 (`search_knowledge`).
- **Memoria aprendida** en lenguaje claro y editable. Aprende de los rechazos con su motivo, del chat y de su propio trabajo.

**Disparadores**
- Rutinas cron diarias, semanales o mensuales.
- **Eventos del CRM** mediante reglas de flujo (acción *Encargar a un empleado digital*, que recibe la ficha y los cambios).
- Seguimientos que se programa él mismo, encargos manuales, respuestas a sus preguntas y el chat del panel.

**Autonomía calibrada por tipo de acción**
- Tipos: consultar, avisar, cambiar datos, comunicarse con clientes e irreversible.
- Para cada tipo: *lo hace solo*, *pide aprobación* o *prohibido*. Cuatro niveles predefinidos (Observador, Asistente, Colaborador, Autónomo) y excepciones por herramienta.
- Las herramientas de los conectores se clasifican solas por su riesgo:
  1. Primero, las **anotaciones oficiales de MCP** (`readOnlyHint` / `destructiveHint`).
  2. Si no las hay, se trocea el nombre en palabras (`ZohoCRM_getTasksRecords` → zoho · crm · **get** · tasks · records) y se busca el verbo en cualquier posición: get/list/search → consultar, create/update → datos, send/email/remind → clientes.
  3. Un verbo irreversible (delete, void, write off, refund…) **manda aunque no sea el primero**.
  4. Lo desconocido se trata como cambio de datos.
- Si una acción aprobada **falla al ejecutarse**, el empleado recibe el error y los parámetros usados, los corrige y lo reintenta.
- **«Aprobar y permitir siempre»** crea la excepción para que esa herramienta no vuelva a pedir aprobación.
- Las acciones prohibidas ni se ofrecen al modelo y se bloquean aunque las intente.
- Límites de acciones por tarea y de tareas al día, horario laboral y caducidad de aprobaciones.

**Humano en el bucle**
- Bandeja de aprobaciones con el motivo de cada propuesta.
- Aprobación por **Telegram con botones** ✅/❌.
- Aprobar ejecuta la acción. Rechazar con motivo se convierte en aprendizaje.
- Las preguntas del empleado (`ask_human`) llevan botones, y la respuesta le vuelve como tarea.

**Observabilidad**
- Cada tarea (`WorkerRun`) guarda la traza completa: razona → acción → bloqueado → aprobación → decisión, con tiempos.
- Al terminar, resumen para el responsable (panel, email o Telegram), solo si hubo algo relevante.

**Chat en streaming** con el empleado dentro de su configuración.

**Documentos** (`modules/worker/documents.js`)
- El empleado procesa los documentos que **recibe** (panel, chat, enlace, `POST /v1/bots/:id/worker/files`) o que **se encuentra** trabajando: los archivos que devuelven los conectores MCP (recursos binarios, imágenes, enlaces) pasan a su bandeja y se le indica su referencia `doc:…`.
- **Analista de documentos** con el contexto del puesto (misión, responsabilidades, manual) y sus **reglas de documentos** (tipo → qué hacer → datos a extraer). Devuelve tipo, regla aplicada, resumen, datos estructurados, confianza, incidencias y acciones sugeridas.
- Formatos:
  - PDF (incluidos escaneados) e imágenes van **nativos** al modelo, sea Claude o GPT.
  - Word (mammoth), Excel/CSV (SheetJS, cada hoja como CSV), texto, HTML y JSON se convierten a texto.
  - Máximo 10 MB. Las descargas pasan por la protección SSRF.
- Herramientas `analyze_document`, `list_documents` y `mark_document`. Lo que haga después (registrar, avisar, pedir datos) respeta su autonomía y sus aprobaciones.
- Procesamiento automático opcional al llegar a la bandeja. Los documentos se conservan 180 días.

**Canales de avisos y aprobaciones** (`modules/worker/channels.js`)
- Cada informe, pregunta o aprobación llega a **todos los canales activos**:
  - JuntialAgents (siempre).
  - Email a varios destinatarios.
  - Telegram (opcional).
  - Webhook firmado.
- Se puede **decidir desde cualquiera** y el resto se sincroniza: se quitan los botones de Telegram y se emite `approval.decided` con quién decidió y por qué vía.
- **Enlaces seguros**: token de un solo uso por aprobación (se guarda su hash) que caduca con la aprobación. Abre la página `/a/:token` y la decisión solo se toma con un POST desde ella, así que los antivirus de correo que abren enlaces no aprueban nada.
- **Webhook**:
  - Eventos `approval.requested` (incluye `decide.url`), `approval.decided`, `worker.report` y `worker.question`.
  - Firma `X-JuntialAgents-Signature: t=…,v1=HMAC(secreto, t.cuerpo)`.
  - Un sistema externo decide con `POST decide.url {"decision":"approve"|"reject","feedback","decidedBy"}`. Devuelve 409 si ya estaba decidida.
- **Diagnóstico real**: *Probar avisos* y *Enviar aprobación de prueba* envían en el momento (sin cola) a cada canal activo y devuelven qué funcionó y por qué falló cada uno: SMTP sin configurar, bot sin acceso al chat, dominio inexistente, HTTP de error… La aprobación de prueba se puede decidir desde cualquier canal y aprobarla no cambia nada.
- **El email necesita SMTP** (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`) en el `.env` **de la API y del worker**. Sin él, el diagnóstico lo indica (antes se descartaba en silencio).

## Observabilidad y registro

- **Trazas correlacionadas** (`AsyncLocalStorage`): todo lo que ocurre en un turno de Telegram, una petición web o una tarea del empleado comparte `traceId`, origen, chat y tiempo transcurrido.
- Registro `agent.turn` con modelo, tokens (incluida la caché), pasos y tiempos de IA y herramientas.
- `GET /api/bots/:id/logs` admite filtros por nivel (varios), evento, texto, traza, chat y rango, con paginación por cursor.
- `/logs/stats` devuelve el resumen de 24 horas e histograma por hora. `/logs/export` exporta en CSV o NDJSON.

## Entorno de desarrollo de funciones

- Logs con nivel y marca de tiempo (`jx.log/info/warn/error`, `console.*`).
- **Traza de cada llamada al SDK** con parámetros, respuesta, duración y detalle HTTP.
- **Error con la línea y columna exactas** del código del usuario, incluidos los de sintaxis.
- Historial de versiones (50) y casos de prueba guardados.

## Botones en Telegram

- **Generados por el agente** (`show_options`): decide cuándo ofrecer 2–8 opciones. También admite botones de enlace (`"Texto | https://…"`).
- **Conjuntos fijos** definidos en el panel (`show_button_set`): el agente los muestra cuando se da la situación descrita.
- **Menú fijo** en chats privados (teclado bajo el campo de texto): aparece con `/start` o `/menu` y al cambiar su configuración.
- Al pulsar un botón:
  - Se confirma al instante (`answerCallbackQuery`).
  - El mensaje queda marcado con *✅ opción* y sin botones.
  - La elección llega al agente como «[Botón pulsado] opción» junto con la pregunta original.
  - Solo cuenta una elección por mensaje, y los botones caducan a los 7 días.
- También se pueden enviar desde las **reglas de flujo** (campo *Botones* de la acción Telegram) y desde `POST /v1/bots/:id/messages` (`buttons`). Esos mensajes quedan en el historial, así el agente sabe a qué responde el usuario.
- `TELEGRAM_API_BASE` permite usar un servidor propio de la Bot API.

## Agentes web incrustados (script)

Además de bots de Telegram, cada cliente puede crear **agentes web** que se instalan con una línea:

```html
<script src="https://api.tudominio.com/widget/v1/widget.js" data-agent="ja_pk_…" async></script>
```

- **Misma configuración** que los bots: modelo (Claude o GPT), instrucciones, procedimientos, conectores MCP y webhooks.
- **Marco agéntico con procedimientos (playbooks)** en vez de diagramas de flujo, más acciones deterministas: `show_options` (botones), `capture_lead`, `request_contact_form` y `handoff_human` (aviso por plataforma, email y opcionalmente un grupo de Telegram).
- **Chat** con respuesta en streaming (SSE), Markdown, imágenes (adjuntar, pegar, arrastrar o cámara; se reducen a 1568 px antes de enviarse) y restauración de la conversación.
- **Voz manos libres** tipo ChatGPT: VAD adaptativo en el navegador, turnos automáticos, interrupción (*barge-in*), orbe animado que reacciona a la voz del usuario y del agente, y subtítulos en vivo. El cerebro sigue siendo Claude o GPT:
  - `browser`: reconocimiento y voz del dispositivo (gratis).
  - `openai`: gpt-4o-mini-transcribe + gpt-4o-mini-tts.
  - `elevenlabs`: Scribe + Flash v2.5.
  El audio se sintetiza **frase a frase mientras el modelo escribe** y se reproduce en orden sin cortes.
- **Seguridad de canal público**: dominios autorizados por agente, token de visitante firmado (24 h), límites por visitante/IP/agente, un turno a la vez por conversación, cuota del plan, instrucciones anti-inyección y **aviso obligatorio** antes de conectar MCP.
- Eventos de webhook nuevos: `conversation.started`, `lead.captured`, `handoff.requested`.
- Endpoints públicos: `GET /widget/v1/widget.js`, `GET /widget/v1/agents/:pk/config`, `POST …/session`, `POST /widget/v1/chat` (SSE), `POST /widget/v1/voice` (SSE), `POST /widget/v1/lead`.

## Juntial Center (organizaciones y aplicaciones, estilo Zoho One)

`modules/center/*` · API `/api/center` y `/v1/center`.

- **Organizaciones**: una persona puede pertenecer a varias y cambiar entre ellas (`POST /center/orgs/:id/switch` y después `/api/auth/refresh`). Se pueden crear nuevas.
- **Miembros**: rol en la organización (propietario, administrador, miembro), áreas, puesto, responsable y **rol por aplicación** (`appRoles.juntialagents`: admin, editor, viewer o none). También se guarda el usuario de Telegram para decidir aprobaciones desde los botones.
- **Invitaciones** por email (7 días), que se aceptan en `/invite/:token`.
- **Permisos por aplicación** (`appGuard`) en el panel, en la API v1 y en el MCP:
  - Un *viewer* solo lee.
  - Un *editor* lo gestiona todo salvo la administración (claves de API y plan).
  - Si una app está desactivada en la organización, se bloquea para todos.
- **Áreas o departamentos** con responsable y jerarquía.
- **Catálogo de apps** (`modules/center/apps.js`): añadir una app nueva consiste en añadir una entrada, con sus roles y los eventos que publica y consume.
- **Conexiones compartidas** (bearer, API key, basic, cabeceras, OAuth2 client credentials), cifradas y limitadas a su URL base. Desde las funciones se usan con `jx.connections.request('erp', { url, method, body })` sin ver nunca el secreto.
- **Bus de eventos** (`publish` y `subscribe`) con suscripciones por webhook firmado (`X-Juntial-Signature`). Eventos: `approval.requested/step/escalated/decided`, `worker.run.completed`, `center.member.*`, `center.app.*`, `center.ai_app.connected`… Es la base para conectar las herramientas de Juntial entre sí.
- **Migración automática**: al arrancar, cada organización existente tiene a su dueño como propietario y administrador de JuntialAgents.

## Aprobaciones avanzadas (políticas por rol, área, tipo de cambio e importe)

`modules/center/approvals.js`

- **Política**:
  - *Cuándo se aplica*: app, agentes, área del agente, tipo de acción, patrón de herramienta e importe mínimo (se detecta en total, importe, amount…).
  - Se aplica la primera que encaje según su prioridad.
- **Cadena de pasos**, cada uno con:
  - Sus aprobadores: personas concretas, un rol (de organización o de app), los miembros de un área o el **responsable del área del agente**.
  - Un modo: *uno cualquiera*, *todos* o *un mínimo N*.
  - Un plazo con su acción al vencer: recordar, **escalar**, aprobar o rechazar (revisión cada 15 minutos).
- **Cada aprobador recibe su enlace personal** (y aviso en la campana) y su voto queda a su nombre. Se puede votar desde el panel, desde Center, por email, por Telegram (con el usuario vinculado) o por webhook (con `decidedBy`). Solo vota quien tiene el paso actual; el propietario puede forzar la decisión.
- Si un paso se queda sin aprobadores, decide el propietario: ninguna aprobación queda huérfana.
- Simulador: `POST /center/policies/simulate` responde «¿quién aprobaría esto?». La bandeja de aprobaciones de toda la organización está en `GET /center/approvals`.

## MCP + OAuth 2.1 para Claude, ChatGPT y cualquier cliente MCP

`modules/oauth/*` · Servidor en **`{PUBLIC_API_URL}/mcp`** (Streamable HTTP, sin estado).

- **Servidor de autorización**:
  - Metadatos RFC 8414 (`/.well-known/oauth-authorization-server`) y RFC 9728 (`/.well-known/oauth-protected-resource`).
  - **Registro dinámico de clientes** RFC 7591 (`/oauth/register`).
  - `/oauth/authorize` con **PKCE S256 obligatorio** y `resource` (RFC 8707). Los tokens se piden en `/oauth/token` (código y *refresh* con **rotación atómica**) y se revocan en `/oauth/revoke`.
  - Sin token, `/mcp` responde 401 con `WWW-Authenticate: Bearer resource_metadata=…`, como exige la especificación.
- **Consentimiento** en el panel (`/oauth/consent`) con la sesión de JuntialAgents: la persona elige la organización y si da solo lectura o también escritura.
- El **token OAuth sirve también en la API v1**, con los permisos del rol de esa persona en su organización.
- **39 herramientas** con anotaciones (`readOnlyHint` / `destructiveHint` / `openWorldHint`), más `search` y `fetch` para ChatGPT. Cubren:
  - agentes y empleados digitales (preguntar, encargar, actividad, trazas, logs);
  - aprobaciones (ver, decidir, simular);
  - CRM, campos, reglas de flujo (crear, modificar, activar, probar) y funciones (crear, modificar, ejecutar);
  - documentos, Telegram, consumo, miembros, áreas y eventos.
- Las herramientas usan la API v1 con el token de la persona, así que aplican la misma validación, los límites del plan, el aislamiento por organización y la auditoría que el panel.
- **Requisito**: `PUBLIC_API_URL` debe ser una URL **https pública** (tu dominio o el túnel) para que Claude o ChatGPT puedan conectarse.

## CRM, reglas de flujo y funciones (estilo Zoho)

- **Campos**: módulo *Contactos* con campos de sistema (nombre, email, teléfono, empresa, estado, origen, notas) y **campos personalizados** de 12 tipos (texto, número, moneda, fecha, fecha y hora, lista, selección múltiple, sí/no, URL…). Cada campo puede marcarse como **"el agente puede rellenarlo"**, con una indicación para la IA.
- **El agente rellena la ficha mientras conversa** (Telegram y web) con `crm_get_contact` y `crm_update_contact`. El esquema se genera a partir de tus campos, con validación por tipo, números escritos por personas ("25.000", "25k", "12 €") y sin duplicados por email. Los datos del formulario o de `capture_lead` también llegan al CRM.
- **Reglas de flujo**:
  - *Cuándo*: al crear, al editar, al crear o editar, al cambiar campos concretos, al eliminar, o por fecha (antes, en el momento o después de un campo de fecha).
  - *Condiciones*: 21 operadores, con *todas* o *alguna*.
  - *Acciones* **instantáneas o programadas**: email, Telegram (a un chat o al propio contacto, con mensaje fijo o redactado por el agente), webhook firmado, actualizar campo, aviso y función.
  - **Alcance global o por agentes** (individual o de grupo).
  - Sin "repetir", en ediciones solo se ejecuta cuando el contacto **pasa** a cumplir las condiciones, como en Zoho.
  - **Anti-bucles**: un cambio hecho por una regla o función puede encadenar como máximo 3 niveles.
  - Las acciones programadas comprueban de nuevo las condiciones antes de ejecutarse.
  - Historial de ejecuciones y prueba en seco con un contacto.
- **Funciones JavaScript** (espacio de desarrollador): `main(record, ctx)` recibe el registro, como en Deluge.
  - Se ejecutan **aisladas en QuickJS/WebAssembly**: sin Node, sin sistema de archivos y sin acceso a otros clientes.
  - Límites: 32 MB de memoria, tiempo máximo configurable, 10 llamadas HTTP y 5 emails por ejecución.
  - **Protección SSRF**: no pueden acceder a redes privadas ni a los metadatos de la nube.
  - SDK síncrono `jx`: `records.get/update/create/search`, `http.get/post/request`, `email.send`, `telegram.send`, `notify`, `env` (variables secretas cifradas) y `log`.
- **API pública**: `/v1/crm/*` con los permisos `crm:read|write` (contactos) y `crm_admin:read|write` (campos, reglas y funciones).
- **Límites por plan**: catálogo único en `modules/plans/limits.js` con 11 límites (agentes, mensajes/mes, conectores, tareas, webhooks, API keys, peticiones/min, contactos, reglas, funciones, días de historial).
  - Si un plan antiguo no tiene un límite nuevo, se usa el valor de su nivel (nunca 0), y al arrancar la API o el worker se añade a la base de datos automáticamente.
  - `npm run seed` ya no sobrescribe los límites que hayas editado.
  - `GET /api/plans/me` devuelve el consumo de cada recurso.

## Acceso de administración (equipo)

Superadmin, admin y empleados entran **solo** por `/admin/login` del frontend, nunca por el login de clientes (que les responde `STAFF_PORTAL`).

1. Email + contraseña → token temporal de 5 min.
2. Código de la app autenticadora (TOTP RFC 6238) o código de respaldo → sesión de 30 días.
3. En el primer acceso se configura la app con un QR y se entregan 8 códigos de respaldo de un solo uso.

Bloqueo de 15 min tras 5 fallos por cuenta o IP, protección contra reutilización de códigos y auditoría de cada intento (`staff.login.*`).

```bash
npm run set-password -- tu@email.com 'ClaveSegura2026!'            # superadmin con contraseña
npm run set-password -- otro@email.com 'OtraClave2026!' admin      # admin o employee
npm run reset-mfa -- persona@email.com                             # si pierde el móvil y los códigos
```

`STAFF_MFA_REQUIRED=false` desactiva el segundo factor (solo para desarrollo).

## API pública v1

**Claves**: se crean desde el portal *API* del frontend (o `POST /api/developer/keys`). Solo se guarda su SHA-256; se muestran una vez. Admiten permisos por recurso, caducidad, lista de IPs/CIDR, rotación sin cortes y revocación inmediata.

**Permisos de cliente**: `bots:read|write`, `messages:send`, `agent:run`, `chats:read|write`, `tasks:read|write`, `webhooks:read|write`, `mcp:read|write`, `usage:read`, `support:read|write`.

**Permisos de administrador**: `admin:read`, `admin:write`, `admin:support`, `platform:webhooks` (y todos los de cliente sobre cualquier cuenta con `?tenantId=`). El poder de una clave de admin se recalcula con el rol actual de su dueño: si se le degrada o deshabilita, la clave deja de funcionar en ≤60 s.

**Endpoints exclusivos de la API**:
- `POST /v1/bots/:id/messages` — enviar un aviso (o una tarea del agente) a chats de Telegram. Asíncrono, devuelve `jobId`; estado en `GET /v1/jobs/:id`.
- `POST /v1/bots/:id/agent` — usar el bot como motor de IA desde tu sistema (prompt, modelo y conectores MCP del bot, opcionalmente con la memoria de un chat). Admite imágenes.
- `GET /v1/me` — introspección de la clave.
- `/v1/admin/platform-webhooks` — suscribirse a eventos de toda la plataforma: `user.created`, `tenant.created`, `tenant.status_changed`, `plan.changed`, `plan.requested`, `bot.created`, `bot.deleted`, `bot.connected`, `ticket.created`, `ticket.replied`, `usage.limit_reached`.
- `/v1/admin/api-keys` — inventario y revocación de cualquier clave.

El resto (`/v1/bots`, `/v1/connectors`, `/v1/support`, `/v1/usage`, `/v1/admin/users|tenants|plans|audit|stats`) reutiliza exactamente la misma lógica de negocio que la web.

**Convenciones**: errores `{ error: { code, message, details, requestId } }` · `Idempotency-Key` en POST (24 h) · rate limit por clave según el plan con `RateLimit-Policy` y `Retry-After` · webhooks firmados `X-JuntialAgents-Signature: t=…,v1=HMAC-SHA256(t.body)` · cada petición queda registrada 30 días (visible en el portal).

```bash
curl -X POST https://api.tudominio.com/v1/bots/BOT_ID/agent \
  -H "Authorization: Bearer $JUNTIAL_KEY" -H "Content-Type: application/json" \
  -d '{"input":"Resume los tratos abiertos de esta semana"}'
```

## Funcionalidad de la plataforma

- **Roles**: superadmin, admin, empleado, cliente (RBAC; nadie gestiona rangos iguales o superiores; auditoría 12 meses).
- **Acceso**: Google, email + contraseña (argon2id) y código OTP; sesión de 30 días absolutos con rotación de refresh y detección de robo.
- **Bots**: token de @BotFather cifrado, Claude o GPT con la clave del cliente, respuesta en grupos por mención/respuesta/comando/palabra clave, memoria y proyecto por chat, texto + imágenes + PDF + audio, mensaje de progreso que se edita hasta la respuesta final.
- **Anti-flood**: deduplicación, buffer acotado por chat, agrupación de ráfagas en un solo turno, lock por chat, límite por remitente y límites oficiales de salida de Telegram con manejo de 429 (100 mensajes seguidos → 1 ejecución del agente).
- **Conectores MCP**: Streamable HTTP/SSE con ninguna, Bearer, API key, Basic, cabeceras, OAuth 2.0 + PKCE (descubrimiento y registro dinámico) y client credentials.
- **Tareas programadas** (BullMQ Job Schedulers), **webhooks** entrantes y salientes, **planes** con cuotas, **soporte** con chat en tiempo real y **16 notificaciones** transaccionales.
- **Observabilidad**: logs JSON con secretos redactados, `/healthz`, `/readyz`, `/metrics` (Prometheus).

## Puesta en marcha

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # ENCRYPTION_KEY
npm install
npm run seed          # planes + superadmin (SUPERADMIN_EMAIL)
npm run dev:api       # terminal 1
npm run dev:worker    # terminal 2
```

- `CORS_ORIGINS`: dominio(s) del frontend. Si el frontend está en otro dominio, `COOKIE_SAMESITE=none` y HTTPS.
- `PUBLIC_API_URL` debe ser HTTPS público (Telegram y OAuth). En local: `cloudflared tunnel --url http://localhost:4000`.
- Redis con persistencia y `maxmemory-policy noeviction` (requisito de BullMQ).
- Restringe `/metrics` a la red interna.

## Estructura

```
src/
  api/          API pública v1: keyAuth, scopes, acciones, OpenAPI
  modules/      auth, bots, mcp, tasks, webhooks, support, plans, admin, developer, platform, notifications
  telegram/     ingress (anti-flood), processor, api (límites), progress, context, sender
  ai/           agente, proveedores Claude/GPT, transcripción, herramientas nativas
  jobs/         tareas, webhooks entrantes, email, mantenimiento
  models/       esquemas Mongoose con índices y TTL
```


## Empleado digital: equipo, canales, proactividad y memoria de trabajo
- **Estilo:** cada tarea termina con `<aviso>` (corto, tipo WhatsApp, máximo 6 líneas, lo que llega por Telegram o email) y un `<detalle>` opcional que solo se ve en el panel (`WorkerRun.detail`). En el chat responde como un compañero. Estilo configurable: `worker.style` = `corto` o `detallado`.
- **Actúa en vez de describir:** si algo se arregla con un cambio, usa la herramienta y el sistema crea la aprobación sola. Las aprobaciones llegan como pregunta directa, con el motivo en una frase.
- **Memoria de trabajo:**
  - `worker.threads` son los pendientes abiertos y cerrados. Se gestionan con la herramienta `track` y aparecen en cada prompt.
  - `worker.journal` es una línea por tarea o conversación, para recordar lo que ha ido haciendo.
- **Equipo** (`worker.people`): nombre, puesto, relación, email, Telegram, si puede aprobar y notas. Sirve para identificar quién habla en cada canal y para avisar a alguien con `message_person`, que elige su canal: Telegram si ya escribió al bot, si no, email.
- **Canales para hablar con él:**
  - **Telegram** (`worker.channels.telegramChat`): el bot de informes responde como el empleado si le escribe alguien del equipo o el chat de informes. Aprende solo el chat de cada persona.
  - **Página personal** `GET /w/<enlace>`: chat tipo WhatsApp sin iniciar sesión, con un enlace por persona en la colección `WorkerLink`, revocable.
  - **API/webhook** `POST /v1/bots/:id/worker/message` `{ text, from: { email | telegram | name }, conversation? }` → `{ reply }`.
- **Aprobar hablando:** solo quien tiene `canApprove` (o un usuario del panel) puede decidir conversando. Quien no puede aprobar no ve esa opción.
- **Proactivo** (`worker.proactive`): un latido cada N horas, en horario laboral, que repasa sus pendientes (los vencidos primero), recuerda las aprobaciones de más de 20 horas y avisa solo si hay algo que hacer (`[SIN_NOVEDADES]` en caso contrario).

### Varios aprobadores (sin política de Juntial Center)
- Las personas del equipo con `canApprove` son los **aprobadores**. Cada una recibe la solicitud **a su nombre**: por Telegram privado con botones, si ya escribió al bot, o por email con un **enlace personal** (`personTokens`).
- **Regla** `worker.approvalRule`: `any` (basta uno), `all` (todos) o `quorum` (un mínimo). Los votos necesarios se guardan en la aprobación al crearla (`need`).
- **Votos** `WorkerApproval.votes`: uno por persona, con nombre y canal. Un rechazo lo para al momento. Los votos parciales se comunican en todos los chats («Antonio ha aprobado (1/2)»).
- `onlyApprovers` (activo por defecto): nadie más puede decidir, aunque esté en el chat de informes o tenga un email reenviado. Con aprobadores definidos no se envía el enlace compartido a los emails de informes. Los administradores de la organización deciden siempre: desde el panel, o por Telegram si lo tienen vinculado en Center.
- Al decidirse, se cierran los botones de **todos** los mensajes de Telegram de esa aprobación (`tgMessages`).
- Sin aprobadores en el equipo, funciona como antes: decide cualquiera del chat de informes o quien tenga el enlace.
- Todos los canales (Telegram, enlace personal, chat, webhook con `decidedBy`) pasan por `voteApproval()`.
