# Tu PC como servidor (gratis, con tu dominio)

Usas **DuckDNS** (gratis): te da un dominio como `juntial.duckdns.org` que siempre apunta a tu PC,
aunque tu IP de internet cambie. **Caddy** da el HTTPS automático (necesario para Telegram, Google y el MCP).
**PM2** mantiene la API y el worker funcionando y los reinicia solos si tu PC se reinicia.

No necesitas pagar nada. Sí necesitas que tu router reenvíe los puertos 80 y 443 a tu PC (abajo se explica).

## 0. Qué vas a tener
```
Internet → tu router (puertos 80/443) → tu PC
                                          ├─ Caddy (HTTPS) :443 → API Node :4000
                                          ├─ API + worker (Node, con PM2)
                                          ├─ MongoDB (local)
                                          └─ Redis (local, vía WSL o Memurai)
```

## 1. DuckDNS (dominio gratis)
1. Entra en **https://www.duckdns.org**, inicia sesión (con Google, por ejemplo).
2. Crea un subdominio, por ejemplo `juntial` → te queda `juntial.duckdns.org`.
3. Copia tu **token** (arriba de la página).
4. Edita `duckdns\update.ps1` de este paquete: pon tu `DOMAIN` y `TOKEN`.
5. Como **administrador**, en PowerShell, dentro de esa carpeta:
   ```powershell
   .\install-task.ps1
   ```
   Esto crea una tarea programada que actualiza tu IP cada 5 minutos, incluso tras reiniciar el PC.
6. Comprueba: abre `https://www.duckdns.org` y mira que tu dominio muestre tu IP actual.

## 2. Abrir los puertos en tu router (port forwarding)
1. Entra en tu router (normalmente `192.168.1.1`) con usuario y contraseña de administrador.
2. Busca **Port Forwarding / Reenvío de puertos / Virtual Server**.
3. Añade dos reglas, apuntando ambas a la **IP local de tu PC** (`ipconfig` → "Dirección IPv4"):
   - Puerto externo **80** → tu PC, puerto **80**
   - Puerto externo **443** → tu PC, puerto **443**
4. Dale a tu PC una **IP local fija** (en el router, "DHCP reservation" / reserva de IP por MAC), para que no cambie y rompa las reglas.
5. Comprueba desde tu móvil (con datos, no con el wifi de casa) que `http://TU_IP_PUBLICA` no da "conexión rechazada" (puede dar error de la app, eso es normal: solo comprobamos que el puerto llega).

**Si tu operador no te da IP pública** (algunos usan CG-NAT y verás que tu IP en `https://whatismyip.com` no coincide con la del router): port forwarding no funcionará. En ese caso, la alternativa es un túnel (Cloudflare Tunnel o ngrok con dominio fijo), que es gratis igualmente — dímelo y te preparo esa variante.

## 3. Instalar lo necesario en tu PC
Con `winget` (ya viene en Windows 10/11):
```powershell
winget install OpenJS.NodeJS.LTS
winget install MongoDB.Server
winget install Caddy.Caddy
npm install -g pm2 pm2-windows-startup
```
**Redis**: Windows no lo soporta de forma oficial. Dos opciones, ambas gratis:
- **Memurai** (recomendado, nativo de Windows): https://www.memurai.com/get-memurai → instala la edición gratuita (Developer).
- O WSL2 con Redis dentro (más pasos). Memurai es más sencillo para esto.

## 4. Configurar y arrancar
1. Descomprime el backend en, por ejemplo, `C:\juntial\juntialagents-backend`.
2. Copia `.env.example` a `.env` y rellena:
   ```
   PUBLIC_API_URL=https://juntial.duckdns.org
   WEB_URL=https://juntial.duckdns.org          # si sirves el panel también aquí (ver paso 6)
   CORS_ORIGINS=https://juntial.duckdns.org
   MONGO_URI=mongodb://127.0.0.1:27017/juntialagents
   REDIS_URL=redis://127.0.0.1:6379
   ```
   El resto (`ENCRYPTION_KEY`, `JWT_*`, etc.) como ya los tenías.
3. Dentro de la carpeta del backend:
   ```powershell
   npm install
   npm run seed
   ```
4. Copia `Caddyfile` de este paquete a `C:\juntial\Caddyfile`, cambiando `juntial.duckdns.org` por tu dominio.
5. Arranca todo con PM2 (desde `C:\juntial\juntialagents-backend`):
   ```powershell
   pm2 start src/server.js --name juntial-api
   pm2 start src/worker.js --name juntial-worker
   pm2 start caddy --name juntial-proxy -- run --config C:\juntial\Caddyfile
   pm2 save
   pm2-startup install
   ```
   `pm2 save` + `pm2-startup install` hacen que todo vuelva a arrancar solo si el PC se reinicia o se va la luz.
6. Comprueba desde el móvil con datos: `https://juntial.duckdns.org/healthz` → debe responder `ok`.

## 5. Frontend
Mientras no pagues Vercel, dos opciones:
- **Servirlo desde el mismo PC** (más simple): compílalo y que Caddy lo sirva. Ver sección siguiente.
- O deja el frontend en Vercel (su plan gratis no tiene coste) y solo el backend en tu PC. En ese caso `WEB_URL`/`CORS_ORIGINS` deben ser la URL de Vercel, no la de DuckDNS.

### Servir el frontend desde tu PC (todo junto, gratis)
```powershell
cd C:\juntial\juntialagents-frontend
echo VITE_API_URL=https://juntial.duckdns.org > .env.production
echo VITE_GOOGLE_CLIENT_ID=tu_client_id      >> .env.production
npm install
npm run build
```
El `Caddyfile` de este paquete ya sirve esa carpeta `dist` en `/` y la API en `/api`, `/v1`, `/mcp`, `/tg`, `/widget`, `/oauth`, `/.well-known`, `/a` y `/hooks`. Así todo queda en `https://juntial.duckdns.org`.

## 6. Después de tener todo arriba
- **Telegram**: `npm run telegram:rewebhook` (apunta los bots a tu dominio DuckDNS).
- **Google**: añade `https://juntial.duckdns.org` a los orígenes autorizados de tu cliente OAuth.
- **MCP (Claude/ChatGPT)**: `https://juntial.duckdns.org/mcp`.

## Limitaciones a tener en cuenta
- **Tu PC tiene que estar siempre encendido** y sin suspenderse: en Windows, Configuración → Energía → "Nunca" apagar pantalla/suspender cuando esté conectado a la corriente, y desactiva la suspensión automática.
- Si **apagas el PC o se va la luz**, el servicio cae; PM2 lo recupera todo solo al volver a encender.
- Tu **velocidad de subida** de internet es la que verán tus clientes: si es baja, el agente web y los documentos irán lentos.
- Es una solución para **empezar y probar**, no para muchos clientes a la vez: un router doméstico y un PC no están pensados para eso. En cuanto factures, pasa al `render.yaml` de pago (API y worker separados) sin tocar el código.
- **Seguridad**: solo abras 80 y 443 (nunca 27017 de Mongo ni 6379 de Redis al router). Este paquete ya lo da por hecho.
