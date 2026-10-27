# Despliegue en producción (Render + Vercel + MongoDB Atlas)

## Arquitectura
- **app.tudominio.com** → Vercel (panel React)
- **api.tudominio.com** → Render Web Service `juntial-api` (API, API v1, MCP + OAuth, webhooks de Telegram, widget)
- Render Background Worker `juntial-worker` (agentes, rutinas, reglas de flujo, emails, webhooks)
- Render Key Value `juntial-redis` (BullMQ; política `noeviction`, solo red privada)
- MongoDB Atlas (tu clúster actual)

Usa **subdominios del mismo dominio**: las cookies de sesión son *same-site* y funcionan en Safari e iOS. Con `*.onrender.com` y `*.vercel.app` el navegador las trata como de terceros y Safari las bloquea.

## 1. Render (Blueprint)
1. Sube el backend a GitHub con `render.yaml` en la raíz.
2. Render → **New → Blueprint** → elige el repositorio → rellena las variables `sync:false`:
   - `ENCRYPTION_KEY`: **la misma** de tu `.env` actual. Si cambia, no se pueden leer tokens de bots, claves de IA ni conexiones.
   - `JWT_*`, `MONGO_URI`, `GOOGLE_CLIENT_ID`, `SMTP_*`, `MAIL_FROM`, `SUPERADMIN_EMAIL`.
   - `PUBLIC_API_URL=https://api.tudominio.com`, `WEB_URL=https://app.tudominio.com`, `CORS_ORIGINS=https://app.tudominio.com`, `COOKIE_DOMAIN=.tudominio.com`.
3. `juntial-api` → Settings → **Custom Domains** → `api.tudominio.com` (CNAME en tu DNS).
4. Atlas → Network Access → añade las **IP de salida** de Render (cada servicio → Connect → Outbound) en lugar de `0.0.0.0/0`.

## 2. Vercel
1. Importa el frontend → Framework *Vite* (lo detecta `vercel.json`).
2. Variables: `VITE_API_URL=https://api.tudominio.com`, `VITE_GOOGLE_CLIENT_ID=…`.
3. Domains → `app.tudominio.com`.

## 3. Después del primer despliegue
1. Render → `juntial-api` → **Shell**: `npm run telegram:rewebhook` (apunta todos los bots al nuevo dominio).
2. Google Cloud → Credenciales → OAuth Client → orígenes autorizados: `https://app.tudominio.com`.
3. Agentes web: añade los dominios definitivos en *Instalar → Dominios autorizados*. El `<script>` del widget ahora carga desde `https://api.tudominio.com/widget/v1/widget.js`.
4. Claude o ChatGPT: vuelve a conectar el MCP con `https://api.tudominio.com/mcp`.
5. Comprueba que `https://api.tudominio.com/healthz` responde.

## Opción gratuita (para empezar o probar)
- **Render**: *Blueprint* `render.free.yaml`, con un Web Service gratuito que ejecuta API y worker juntos (`node src/all.js`) y un Key Value gratuito.
- **Vercel Hobby** para el panel y **MongoDB Atlas M0** para la base de datos.
- **Evitar que se duerma**: en https://cron-job.org crea una tarea `GET https://<tu-servicio>/healthz` cada 10 minutos. Las 750 h gratuitas al mes cubren un servicio 24/7.
- **Limitaciones**:
  - Render puede reiniciar las instancias gratuitas en cualquier momento.
  - El Key Value gratuito no guarda en disco: las rutinas y tareas se reprograman solas al arrancar, pero se pierden los seguimientos o acciones con retardo pendientes.
  - 512 MB de RAM.
  - Vercel Hobby es para uso no comercial.
- **Para pasar a producción** basta con cambiar al `render.yaml` normal (API y worker separados, Starter). No hay que tocar el código.
