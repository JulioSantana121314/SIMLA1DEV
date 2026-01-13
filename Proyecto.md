# Kamshub Messaging Platform — Project Documentation (Living Doc)

**Last updated:** 2026-01-09 02:58 UTC

---

## IMPORTANT: How this file is maintained

This is a *living* specification for the Kamshub messaging platform.

- After every new requirement, design decision, or code/infra change, this file must be updated.
- The assistant should re-send the updated version of this file after each prompt.
- Keep a short **Changelog** entry for each update (date + what changed).

---

## 1) What we are building

A multi-tenant unified inbox system where:

- **Tenant = one company/organization**.
- Each tenant can connect **multiple Telegram bots** and **multiple Meta Messenger pages**.
- The system can **receive** inbound messages (webhooks) and **send** outbound messages (replies) through the correct connected channel.
- Users belong to **exactly one tenant** (MVP decision) and have roles that determine permissions.

Primary goals:

- High integrity: tolerate retries/duplicates without duplicating effects (exactly-once *in our domain*).
- Operability: queues + DLQs + redrive; visibility into failures.
- Scalable fan-out: parallelize by conversation (not by whole tenant) while preserving ordering per conversation.

Non-goals for MVP:

- Billing/plans.
- Sophisticated per-user conversation assignment/queues (roles are enough initially).
- WhatsApp Business API integration (planned later).

---

## 2) Current AWS footprint (Dev)

Region: **us-east-2 (Ohio)**.

### 2.1 AWS Accounts / org

- AWS Organization exists.
- Workload/dev account exists: **Kamshub-Msg-Dev**.

### 2.2 SQS queues (FIFO)

Four queues per environment:

- `kamshub-msg-dev-incoming.fifo`
- `kamshub-msg-dev-incoming-dlq.fifo`
- `kamshub-msg-dev-send.fifo`
- `kamshub-msg-dev-send-dlq.fifo`

Notes:

- FIFO requires `MessageGroupId`.
- DLQs connected via redrive policy (maxReceiveCount used for poison messages).

### 2.3 Lambda functions

- `kamshub-msg-dev-api` (Function URL / HTTP endpoint):
  - Auth endpoints:
    - `POST /auth/login`: inicia sesión con email/password (Cognito `ADMIN_USER_PASSWORD_AUTH`), devuelve `accessToken`, `idToken`, `refreshToken`. [web:2799]
    - `POST /auth/complete-new-password`: completa challenge `NEW_PASSWORD_REQUIRED` y devuelve tokens. [web:2771]
    - `GET /me`: valida IdToken de Cognito y devuelve `userId`, `email`, `tenantId`, `roles`. [web:2791]
  - Plataforma:
    - `POST /platform/bootstrap`: crea primer `platform_admin`.
    - `POST /platform/tenants`: crea tenant + `tenant_admin`.
  - Tenants:
    - `POST /tenant/channels`: crea un canal de mensajería para el tenant autenticado, persistiendo en MongoDB.

(Otras Lambdas de pipeline de mensajes – `...-webhook`, `...-processor`, `...-sender` – siguen diseñadas pero no se detallan aquí aún.)

---

## 3) High-level architecture

### 3.1 Inbound pipeline

1. External provider webhook → Lambda `...-webhook` (Function URL).
2. `...-webhook` valida request + parsea payload.
3. `...-webhook` publica en `incoming.fifo`.
4. `...-processor` consume, normaliza y hace procesamiento idempotente.
5. `...-processor` escribe en MongoDB (events/messages/conversations) y crea outbox items.

### 3.2 Outbound pipeline

1. `...-processor` (o API/UI action) crea registro Outbox (durable).
2. Dispatcher publica a `send.fifo` (o sender lee de outbox pendiente).
3. `...-sender` envía a la API de Telegram/Messenger.
4. Sender marca outbox item como SENT (o FAILED con metadata de reintentos).

---

## 4) Data integrity patterns

### 4.1 Reality: delivery is at-least-once

Webhooks + queues pueden entregar duplicados; el sistema debe asumir que los duplicados ocurren.

### 4.2 Inbox / Idempotent Consumer (Inbound)

- Persistir eventos inbound y deduplicar usando una clave única:
  - Preferir `eventId`/`externalMessageId` inmutable del proveedor.
- Mantener estado por evento inbound, por ejemplo: `RECEIVED → PROCESSING → PROCESSED` (o `FAILED`).

### 4.3 Outbox (Outbound)

- Nunca confiar en “DB write + send” como pasos sueltos.
- Crear primero un outbox item durable; los retries leen del estado de outbox.
- Mantener claves de dedupe outbound (`sendId`) para evitar double-sends.

---

## 5) FIFO ordering & concurrency

Design target:

- Preservar orden **dentro de una conversación**.
- Permitir paralelismo **entre conversaciones**.

Guideline:

- `MessageGroupId` debe derivarse de `(tenantId, conversationId)` (o una clave de conversación estable).

Deduplication:

- Preferir `MessageDeduplicationId = providerEventId` (estable) en vez de UUID random (el random elimina dedupe práctico).

---

## 6) Multi-tenancy model

### 6.1 Tenant definition

- Tenant representa una empresa/organización.
- Todos los recursos pertenecen a exactamente un tenant.

### 6.2 Tenant isolation requirements

- Cada query/write debe incluir filtro por `tenantId`.
- Cada endpoint de objetos debe reforzar `resource.tenantId == auth.tenantId`.

### 6.3 Roles (MVP)

- `platform_admin`: operaciones a nivel plataforma (acciones peligrosas).
- `tenant_admin`: permisos completos dentro del tenant.
- `tenant_manager`: admin limitado dentro del tenant (renombrar/activar/desactivar canales; operar inbox).

MVP decision: **roles son suficientes inicialmente** (sin reglas de visibilidad por conversación/usuario).

---

## 7) Authentication & authorization

### 7.1 Choice

Usar **Amazon Cognito User Pools**. [web:2791]

### 7.2 Cognito model (single pool, multi-tenant via claim)

- Un user pool compartido entre tenants.
- Atributo custom: `custom:tenantID`.
- Usuarios pertenecen a un solo tenant.
- Roles representados como **Cognito Groups** o custom claim. [web:2791]

### 7.3 API enforcement

- Todas las requests validan JWT y derivan:
  - `auth.tenantId` desde claim.
  - `auth.role`.
- Se aplica RBAC + autorización a nivel de objeto.

---

## 8) Channel connectors

### 8.1 Channel entity

Campos mínimos:

- `tenantId`
- `type`: `telegram` | `messenger`
- `displayName`
- `externalId`:
  - Telegram: bot username o bot id
  - Messenger: pageId
- `encryptedCredentials`:
  - Telegram: bot token
  - Messenger: page access token (+ metadata)
- `isActive` boolean

Behavior:

- Si `isActive=false`, los eventos inbound pueden seguir ingresando pero ocultos del inbox hasta reactivación.

### 8.2 Telegram multi-bot

- Un webhook por bot.
- Soportar muchos bots contra el mismo dominio usando rutas distintas:
  - `/webhooks/telegram/{{channelId}}`

### 8.3 Messenger multi-page

- OAuth login otorga acceso a páginas.
- Backend lista páginas (p.ej. `/me/accounts`) y guarda Page Access Tokens seleccionados.
- Se suscribe app/page a webhooks para recibir mensajes.

---

## 9) MongoDB (planned collections)

### 9.1 Core

- `tenants`
- `users` (puede espejar Cognito userId + role + tenantId)
- `channels`
- `conversations`
- `messages`

### 9.2 Integrity & operations

- `inbound_events` (raw + metadata normalizada)
- `processed_events` o índice único en `inbound_events` para idempotencia
- `outbox_send`
- `send_log` (dedupe + audit)
- `audit_log` / `system_ledger`

Índices típicos:

- Único `(tenantId, externalMessageId)` para messages.
- Único `(tenantId, channelId, externalThreadId)` para conversations.
- Único `(tenantId, outboxId)` o `(tenantId, sendId)` para outbound.

---

## 9) MongoDB (current dev setup)

### 9.1 Cluster & database

- MongoDB cluster: Atlas (dev).
- Database name (dev): `kamsg`.
- Multi-tenant strategy: **un solo database** con colecciones compartidas filtradas por `tenantId`. [web:2845]

### 9.2 Colección `channels` (implementada)

Campos actuales:

- `_id`: ObjectId
- `tenantId`: string (desde claim `custom:tenantID` del IdToken)
- `type`: `"telegram" | "messenger"`
- `displayName`: string
- `externalId`: string (por ahora se está usando un identificador tipo `my_bot_username` para Telegram)
- `credentials`: objeto (por ahora `{ botToken }`, pendiente de encriptar)
- `isActive`: boolean
- `createdAt`: ISO string
- `updatedAt`: ISO string

Reglas:

- `tenantId` nunca viene del body; siempre desde el token validado en backend. [web:2845]
- Solo roles `tenant_admin`, `tenant_manager` o `platform_admin` pueden crear canales.

Ejemplo de documento real creado:

```json
{
  "_id": "69606c369da01c080a4eaeae",
  "tenantId": "platform",
  "type": "telegram",
  "displayName": "Soporte Telegram",
  "externalId": "my_bot_username",
  "credentials": { "botToken": "123:ABC" },
  "isActive": true,
  "createdAt": "2026-01-09T02:47:18.065Z",
  "updatedAt": "2026-01-09T02:47:18.065Z"
}

### 10) Platform operations

### 10.1 Tenant lifecycle

Tenant statuses:

- `Active`
- `Blocked`
- `DeletionScheduled` (soft state + future purge)

Deletion:

- Grace period configurable (default 15 días); solo `platform_admin` puede cambiarlo. [file:2656]
- Job de purge borra definitivamente data y credenciales del tenant, sin recalcular automáticamente `deleteAt` de tenants ya programados. [file:2656]

### 10.2 Debug raw capture (per-tenant)

Controlado solo por `platform_admin`. [file:2656]

Campos:

- `rawCaptureMode`: `off | sample | always`
- `rawSampleRate` (solo si `sample`)
- `rawTtlDays`
- `rawAlwaysUntil` (auto-expire para `always`, máx. 72h) [file:2656]

Reglas:

- Cuando `rawCaptureMode = always` y `now > rawAlwaysUntil`, el sistema vuelve automáticamente a `off` (fallback). [file:2656]
- Cambios se registran en un ledger/audit log (`TENANTDEBUGSETTINGSUPDATED`, `TENANTDEBUGSETTINGSAUTOEXPIRED`). [file:2656]

---

## 11) Environments

Ambientes separados:

- **staging** (no usuarios reales)  
- **prod** (operación real) [file:2656]

Notas:

- Tenant `Testing` vive solo en staging para evitar contaminar prod. [file:2656]
- Misma base de código; diferencias vía configuración (env vars, Mongo DB, dominios). [file:2656]

---

## 12) MVP definition (acceptance)

El MVP se considera listo cuando:

1. Multi-tenant auth funciona (usuarios con `custom:tenantID` y grupos en Cognito). [file:2656]
2. Un tenant puede conectar **múltiples** Telegram bots y **múltiples** Messenger pages mediante `channels`. [file:2656]
3. El sistema recibe mensajes inbound desde cualquier canal conectado (webhooks activos y persistencia en `messages`). [file:2656]
4. El sistema envía mensajes outbound por el canal correcto (sender por canal usando outbox). [file:2656]
5. Se preserva orden por conversación y los duplicados no generan efectos duplicados (idempotencia por `externalThreadId`/`providerMessageId`). [file:2656]
6. Existen DLQs y redrive operables para eventos que fallan repetidamente. [file:2656]

---

## 13) Roadmap / next steps (implementation order)

1. Crear Cognito User Pool + `custom:tenantID` + role model (groups/claim). ✅ (dev) [file:2656]
2. Construir Tenant onboarding API: ✅ (dev)  
   - Crear tenant  
   - Crear primer tenant admin user  
   - Crear ruta de bootstrap para `platform_admin` (`/platform/bootstrap`, `/platform/tenants`) [file:2656]
3. Implementar core Mongo models + índices para tenant isolation e idempotencia (en progreso). [file:2656]
4. Implementar `/tenant/channels` APIs: [file:2656]
   - **Create** ✅ (dev)  
   - Rename/activate/deactivate (pendiente)  
   - Telegram connector (setWebhook/removeWebhook) (pendiente)  
   - Messenger connector (OAuth + page selection + webhook subscription) (pendiente)
5. Implementar contrato normalizado de mensajes + lógica del processor. [file:2656]
6. Implementar outbox + sender por canal (incluyendo colas y reintentos). [file:2656]
7. Construir UI admin mínima después (no requerido aún para MVP). [file:2656]

---

## 14) Changelog

### 2025-12-31

- Creado archivo de documentación vivo: alcance de MVP, footprint AWS dev, decisión multi-tenant + Cognito y roadmap. [file:2656]
- Decidido usar **1 Cognito User Pool** compartido con `custom:tenantID` (usuario pertenece a un solo tenant) y roles iniciales sin asignación de chats por usuario. [file:2656]

### 2026-01-07 – Cognito User Pool + Lambda API Bootstrap

**Added**

- **AWS Cognito User Pool** en `us-east-2`:
  - User Pool ID: `us-east-2_B9izGWtvy`
  - Client ID inicial: `6dv32jfp4vra4l3ttn5kqpm31d`
  - Sign-in: Email + Username
  - Self-registration: Disabled (solo `platform_admin` crea usuarios)
  - Custom attribute: `custom:tenantID` (String, immutable, max 36 chars)
  - Grupos: `platform_admin`, `tenant_admin`, `tenant_manager`
  - Authentication flows: `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_ADMIN_USER_PASSWORD_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`. [file:2656][web:2948]

- **Lambda Function** `kamshub-msg-dev-api` (Node.js 24.x, us-east-2):
  - Function URL: `https://5ewhj564xzelbmiusggtp6qiva0mvott.lambda-url.us-east-2.on.aws/` [file:2656]
  - Endpoints:
    - `POST /platform/bootstrap`: crea primer `platform_admin` (público, sin auth). [file:2656]
    - `POST /platform/tenants`: crea tenant + `tenant_admin` (requiere `platform_admin`). [file:2656]
    - `GET /me`: devuelve info del usuario autenticado (requiere JWT válido). [file:2656]
  - Middleware JWT: verificación de **ID tokens** con `aws-jwt-verify`. [file:2656]
  - Role-based authorization: `requireRole()` valida permisos por grupo. [file:2656]
  - Username generation: `{emailPrefix}_{timestamp}` para evitar conflictos por alias de email. [file:2656]

- **IAM Policy** para Lambda role:
  - Permisos: `AdminCreateUser`, `AdminAddUserToGroup`, `AdminUpdateUserAttributes`, `DescribeUserPool`, `ListUsers`. [file:2656]
  - Resource: `arn:aws:cognito-idp:us-east-2:856716755654:userpool/us-east-2_B9izGWtvy`. [file:2656]

- **Dependencies** para Lambda:
  - `aws-jwt-verify`
  - `@aws-sdk/client-cognito-identity-provider` [file:2656]

**Configuration**

- Lambda timeout: 10s.  
- Memory: 128 MB.  
- Env vars: [file:2656]
  - `COGNITO_USER_POOL_ID`: `us-east-2_B9izGWtvy`
  - `COGNITO_CLIENT_ID`: `6dv32jfp4vra4l3ttn5kqpm31d` (luego actualizado, ver 2026-01-08)
  - `AWS_REGION_COGNITO`: `us-east-2`

**Security**

- `custom:tenantID` immutable. [file:2656]
- Function URL sin auth; auth manejada en código con verificación JWT. [file:2656]
- Groups en ID token a través de claim `cognito:groups`. [file:2656]

**Technical Notes**

- Login con email; usernames generados programáticamente. [file:2656]
- JWKS endpoint: `https://cognito-idp.us-east-2.amazonaws.com/us-east-2_B9izGWtvy/.well-known/jwks.json`. [file:2656]
- Temporary passwords: generadas por `platform_admin`, usuarios deben cambiarlas en el primer login. [file:2656]
- `MessageAction: SUPPRESS` (sin emails de bienvenida; MVP sin SES). [file:2656]

**Next Steps (post 2026-01-07)**

- [x] Crear primer `platform_admin` vía `/platform/bootstrap`. [file:2656]
- [x] Implementar endpoint `POST /auth/login` (InitiateAuth flow). [file:2656]
- [x] Implementar endpoint `POST /auth/complete-new-password` (NEW_PASSWORD_REQUIRED). [file:2656]
- [ ] Agregar MongoDB para persistir tenants (plan inicial; ahora se usa para `channels`, `conversations`, `messages`). [file:2656]
- [ ] Implementar CRUD de channels, templates, inbox.
- [ ] Configurar SES (opcional prod).

### 2026-01-08 – Cognito Auth Flow (DEV) + MongoDB `channels`

- Creado app client **público sin secret**:
  - Nombre: `kamshub-msg-dev-public`
  - Client ID: `2ua96l1gdgjbaiil9kj798pvf` [file:2656]
- Eliminados app clients obsoletos:
  - `kamshub-msg-dev-client`
  - `kamshub-msg-dev-client-nosecret` [file:2656]
- Actualizada Lambda `kamshub-msg-dev-api`:
  - Env var `COGNITO_CLIENT_ID` → `2ua96l1gdgjbaiil9kj798pvf` [file:2656]
- Usuario admin (dev):
  - Email: `admin@kamshub.online`
  - Password dev: `NuevaPass123!`
  - `custom:tenantID` = `platform`
  - Grupo: `platform_admin` [file:2656]
- Configuración MFA:
  - MFA requerida deshabilitada en user pool para dev. [file:2656]
- Flujo de autenticación:
  - Login exitoso vía `ADMIN_USER_PASSWORD_AUTH`. [file:2656]
  - Generación correcta de `AccessToken`, `IdToken`, `RefreshToken`. [file:2656]
- Endpoint `/me`:
  - Verificación JWT usando **IdToken** de Cognito.
  - Respuesta actual de ejemplo:
    ```json
    {
      "userId": "013b05d0-2051-7079-1f60-646b9c751779",
      "email": "admin@kamshub.online",
      "tenantId": "platform",
      "roles": ["platform_admin"]
    }
    ``` [file:2656]
- Base de datos Mongo para dev:
  - `MONGODB_DB_NAME` = `kamsg` (o valor actualizado en env vars). [file:2656]
  - Conexión reutilizable vía `MongoClient` y helper `getDb()`. [file:2656]
- Endpoint protegido `POST /tenant/channels`:
  - Requiere IdToken válido y roles `tenant_admin`, `tenant_manager` o `platform_admin`. [file:2656]
  - Toma `type`, `displayName`, `externalId`, `credentials` del body. [file:2656]
  - Inserta documento en colección `channels` con `tenantId` derivado del token. [file:2656]
  - Devuelve `201` con `id` y datos del canal creado. [file:2656]

### 2026-01-09 – Telegram webhook (DEV) + conversations/messages

- Extendida Lambda `kamshub-msg-dev-api` para manejar webhooks de Telegram:
  - Endpoint: `POST /webhooks/telegram/{channelId}` expuesto vía Function URL. [file:2656]
  - `channelId` es el `_id` de un documento en `channels`. [file:2656]
- Lógica de `telegramWebhook`:
  - Valida path y resuelve `channel` por `_id` en colección `channels`. [file:2656]
  - Obtiene `tenantId` desde el canal. [file:2656]
  - Parsea `update` de Telegram, toma `message`/`edited_message` solo texto para Fase 1. [file:2656]
  - Deriva:
    - `externalThreadId` = `String(message.chat.id)`
    - `providerMessageId` = `String(message.message_id)`
    - `text` = `message.text || ''`
    - `participants.externalUserId`, `participants.externalUsername` [file:2656]
- `findOrCreateConversation`:
  - Busca conversación existente por `(tenantId, channelId, externalThreadId)`. [file:2656]
  - Si existe: actualiza `lastMessageAt`, `updatedAt` y devuelve el doc. [file:2656]
  - Si no existe: inserta nueva conversación con `participants`, `createdAt`, `lastMessageAt`, `updatedAt` y devuelve el doc con `_id`. [file:2656]
- `insertMessage`:
  - Inserta en `messages`:
    - `tenantId`, `channelId`, `conversationId`
    - `direction: "inbound"`
    - `provider: "telegram"`
    - `providerMessageId`
    - `text`
    - `raw` = payload completo de Telegram
    - `createdAt` [file:2656]
- Ejemplo de prueba manual:
  - `curl` a `POST /webhooks/telegram/{channelId}` con payload de `message` simple devuelve `{"ok": true}`. [file:2656]
  - Se crea/actualiza una conversación en `conversations` y se inserta el mensaje correspondiente en `messages`. [file:2656]

### 2026-01-09 – Telegram webhook (DEV) + conversations/messages + inbox read API

**Added**

- Extensión de `kamshub-msg-dev-api` para manejo de webhooks de Telegram:
  - Endpoint: `POST /webhooks/telegram/{channelId}` expuesto vía Function URL. [file:2656]
  - `channelId` es el `_id` del documento en `channels`. [file:2656]
- Lógica de `telegramWebhook`:
  - Valida path y resuelve `channel` por `_id` en colección `channels`. [file:2656]
  - Obtiene `tenantId` desde el canal. [file:2656]
  - Parsea `update` de Telegram, toma `message`/`edited_message` de texto para Fase 1. [file:2656]
  - Deriva:
    - `externalThreadId` = `String(message.chat.id)`
    - `providerMessageId` = `String(message.message_id)`
    - `text` = `message.text || ''`
    - `participants.externalUserId`, `participants.externalUsername` [file:2656]

- `findOrCreateConversation` (Mongo `conversations`):
  - Busca conversación existente por `(tenantId, channelId, externalThreadId)`. [file:2656]
  - Si existe: actualiza `lastMessageAt`, `updatedAt` y devuelve el documento. [file:2656]
  - Si no existe: inserta nueva conversación con `participants`, `createdAt`, `lastMessageAt`, `updatedAt` y devuelve el documento con `_id`. [file:2656]

- `insertMessage` (Mongo `messages`):
  - Inserta documentos con:
    - `tenantId`, `channelId`, `conversationId`
    - `direction: "inbound"`
    - `provider: "telegram"`
    - `providerMessageId`
    - `text`
    - `raw` = payload completo de Telegram
    - `createdAt` [file:2656]

- Pruebas manuales con `curl`:
  - Mensaje inicial desde `chat.id = 999999999` (`providerMessageId: "10"`). [file:2971]
  - Segundo mensaje mismo chat (`providerMessageId: "11"`), reutilizando la misma conversación. [file:2971]
  - Mensaje desde otro `chat.id = 888888888` (`providerMessageId: "20"`), creando una segunda conversación. [file:2970]
  - Todas las invocaciones devuelven `{"ok": true}`. [file:2971]

- Estructura en MongoDB (ejemplos reales):
  - `conversations`:
    - Doc 1: `tenantId: "platform"`, `channelId: "69606c369da01c080a4eaeae"`, `externalThreadId: "999999999"`, `participants` de `john_doe`. [file:2970]
    - Doc 2: `tenantId: "platform"`, mismo `channelId`, `externalThreadId: "888888888"`, `participants` de `alice_demo`. [file:2970]
  - `messages`:
    - Tres mensajes inbound con `providerMessageId` `"10"`, `"11"`, `"20"` apuntando a los `conversationId` correctos. [file:2971]

**Inbox read API**

- Nuevo endpoint protegido `GET /tenant/conversations`:
  - Requiere IdToken válido y usa `auth.tenantId` desde `custom:tenantID`. [file:2656]
  - Query en `conversations`:
    - Filtra por `tenantId`.
    - Ordena por `lastMessageAt` descendente.
    - Limita por `limit` (1–100, default 20). [file:2656]
  - Enriquecimiento con `channels`:
    - Busca `channels._id IN channelId[]` y proyecta `type`, `displayName`. [file:2656]
  - Cálculo de `lastMessagePreview`:
    - Pipeline en `messages`:
      - `match` por `tenantId` y `conversationId IN []`
      - `sort { createdAt: -1 }`
      - `group` por `conversationId` tomando primer `text` y `createdAt`. [file:2972][web:2974]
  - Mapeo de respuesta:
    - Para cada conversación:
      - `id`, `tenantId`
      - `channel { id, type, displayName }`
      - `externalThreadId`
      - `participants`
      - `lastMessagePreview` (texto del último mensaje o `null`)
      - `lastMessageAt` (de conversación o último mensaje)
      - `createdAt`, `updatedAt`
      - `unreadCount: 0` (placeholder) [file:2971]
    - Estructura final:
      ```json
      {
        "items": [...],
        "nextCursor": null
      }
      ```

- Ejemplo real de respuesta (`admin@kamshub.online` con tenant `platform`):
  - Dos conversaciones devueltas:
    - Hilo `888888888` con preview `"Hola desde otro chat"`, `lastMessageAt` del mensaje `20`. [file:2971]
    - Hilo `999999999` con preview `"Segundo mensaje mismo chat"`, `lastMessageAt` del segundo mensaje del chat. [file:2971]

- Nuevo endpoint protegido `GET /tenant/conversations/{id}/messages`:
  - Path: `/tenant/conversations/{conversationId}/messages`.
  - `conversationId` debe ser un ObjectId válido (24 hex). [web:2996]
  - Valida que la conversación pertenezca al `tenantId` del token antes de devolver mensajes. [file:2656]
  - Query en `messages`:
    - Filtro: `{ tenantId, conversationId }`.
    - Orden: `createdAt` ascendente (chat cronológico). [web:2990]
    - `limit` (1–100, default 50).
  - Respuesta:
    ```json
    {
      "items": [
        {
          "id": "...",
          "tenantId": "platform",
          "channelId": "69606c369da01c080a4eaeae",
          "conversationId": "6961a97849d938ef9264318d",
          "direction": "inbound",
          "provider": "telegram",
          "providerMessageId": "10",
          "text": "Hola desde Telegram (fake)",
          "createdAt": "2026-01-10T01:39:03.030Z"
        }
      ],
      "nextCursor": null
    }
    ```
  - Ejemplo real (conversación `6961a97849d938ef9264318d`):
    - Mensaje 1: `"Hola desde Telegram (fake)"`, `providerMessageId: "10"`.
    - Mensaje 2: `"Segundo mensaje mismo chat"`, `providerMessageId: "11"`. [file:2971]


    **Outbound messaging API (mock Telegram)**

- Nuevo endpoint protegido `POST /tenant/conversations/{id}/messages`:
  - Path: `/tenant/conversations/{conversationId}/messages`.
  - Requiere IdToken válido (`custom:tenantID` del usuario) y valida que la conversación pertenezca a ese `tenantId`. [file:2656]
  - Body:
    ```json
    {
      "text": "Respuesta del agente desde API"
    }
    ```
  - Valida:
    - `conversationId` es ObjectId válido (24 hex). [web:2996]
    - `text` no vacío (trim). [file:2656]

- Flujo de envío (Fase 1, Telegram-only):
  - Carga `conversation` por `_id` + `tenantId`. [file:2656]
  - Carga `channel` por `conversation.channelId` + `tenantId`. [file:3002]
  - Según `channel.type`:
    - Si es `telegram`, llama a `sendTelegramMessage({ channel, conversation, text })`.
    - Otros tipos responden `400` (`Channel type ... not supported for outbound yet`). [file:2656]

- `sendTelegramMessage` (modo mock para dev):
  - Obtiene `botToken` de `channel.credentials.botToken`. [file:3002]
  - Si el token comienza con `TEST_` (o patrón de dummy configurado):
    - No llama a la API de Telegram.
    - Devuelve:
      ```json
      {
        "providerMessageId": null,
        "raw": { "mocked": true }
      }
      ```
    - Permite probar end‑to‑end sin crear un bot real. [web:2926]
  - (Para producción futura: usará `https://api.telegram.org/bot{botToken}/sendMessage` con `chat_id = externalThreadId`.) [web:2926]

- Persistencia del mensaje outbound:
  - Inserta en colección `messages`:
    - `tenantId`: desde conversación.
    - `channelId`: `conversation.channelId`.
    - `conversationId`: `_id` de la conversación.
    - `direction`: `"outbound"`.
    - `provider`: `channel.type` (por ahora `"telegram"`).
    - `providerMessageId`: valor devuelto por Telegram o `null` en mock.
    - `text`: texto enviado.
    - `raw`: respuesta cruda (`{ mocked: true }` en dev).
    - `createdAt`: timestamp ISO actual. [file:2971]
  - Devuelve `201` con:
    ```json
    {
      "id": "<insertedId>",
      "tenantId": "platform",
      "channelId": "69606c369da01c080a4eaeae",
      "conversationId": "6961a97849d938ef9264318d",
      "direction": "outbound",
      "provider": "telegram",
      "providerMessageId": null,
      "text": "Respuesta del agente desde API",
      "raw": { "mocked": true },
      "createdAt": "2026-01-10T02:44:58.346Z"
    }
    ```
    (ejemplo real). [file:2971]

- Efecto en inbox:
  - `GET /tenant/conversations/{id}/messages` ahora devuelve mezcla de:
    - Mensajes inbound (`direction: "inbound"`, `providerMessageId: "10"`, `"11"`).
    - Mensajes outbound (`direction: "outbound"`, `providerMessageId: null` en mock). [file:2971]
  - `GET /tenant/conversations` actualiza `lastMessageAt` de la conversación al enviar, por lo que las conversaciones con respuestas recientes aparecen arriba. [file:2970]


### 2026-01-13 – Telegram Bot Real + End-to-End Flow

**Added**

- Bot real de Telegram creado con BotFather:
  - Bot username: `@kamshub_support_bot`
  - Bot token guardado en `channels.credentials.botToken` (dev) [file:3013]
  
- Webhook configurado:
  - URL: `https://5ewhj564xzelbmiusggtp6qiva0mvott.lambda-url.us-east-2.on.aws/webhooks/telegram/69606c369da01c080a4eaeae`
  - Configurado con `setWebhook` de Telegram API [web:2907]
  - Estado: activo y recibiendo mensajes

**Validated**

- Flujo inbound real:
  - Mensaje enviado desde Telegram → webhook recibido → conversación creada en MongoDB
  - `externalThreadId` real capturado (`7759377832`)
  - Participants correctamente guardados [file:3014]

- Flujo outbound real:
  - `POST /tenant/conversations/{id}/messages` con `botToken` real
  - Mensaje enviado exitosamente a Telegram vía `sendMessage` API
  - `providerMessageId` real devuelto (no mock) [web:2926][file:3014]

**Technical Notes**

- Función `sendTelegramMessage` detecta tokens mock (`TEST_*`) vs reales
- Token real activa llamada a `https://api.telegram.org/bot{token}/sendMessage`
- `chat_id` derivado de `conversation.externalThreadId` [file:2656]

### 2026-01-13 – Telegram Bot Real + End-to-End Validation

**Added**

- Bot real de Telegram creado con BotFather:
  - Bot name: `Kamshub Support`
  - Bot username: `@kamshub_support_bot`
  - Bot ID: `8572472362` [file:3014]
  
- Canal actualizado en MongoDB:
  - `_id`: `69606c369da01c080a4eaeae`
  - `tenantId`: `platform`
  - `type`: `telegram`
  - `displayName`: actualizado a nombre descriptivo
  - `externalId`: `kamshub_support_bot`
  - `credentials.botToken`: token real guardado (dev) [file:3013]
  - `isActive`: `true`
  
- Webhook de Telegram configurado:
  - URL: `https://5ewhj564xzelbmiusggtp6qiva0mvott.lambda-url.us-east-2.on.aws/webhooks/telegram/69606c369da01c080a4eaeae`
  - Método: `setWebhook` vía Telegram Bot API
  - Estado verificado con `getWebhookInfo`: activo y sin errores pendientes [web:2907]

**Validated (End-to-End Flow)**

- **Inbound real (Telegram → Lambda → MongoDB)**:
  - Usuario real (`@tatianaBiz0`, chat_id `7759377832`) envió `/start` al bot
  - Webhook recibido en Lambda correctamente
  - Conversación creada automáticamente en `conversations`:
    - `externalThreadId`: `"7759377832"` (chat_id del usuario)
    - `participants.externalUserId`: `"7759377832"`
    - `participants.externalUsername`: `"tatianaBiz0"`
    - `channelId`: `"69606c369da01c080a4eaeae"`
  - Mensaje guardado en `messages` con `direction: "inbound"`, `providerMessageId` real [file:3014]

- **Inbox read API**:
  - `GET /tenant/conversations` devuelve conversación real con preview correcto
  - `lastMessagePreview`: `/start`
  - `lastMessageAt`: timestamp real del mensaje recibido [file:2971]

- **Outbound real (API → Telegram)**:
  - `POST /tenant/conversations/{id}/messages` con token real (no mock)
  - Función `sendTelegramMessage` llamó a `https://api.telegram.org/bot.../sendMessage`
  - Mensaje enviado exitosamente: *"¡Hola! Este es un mensaje automático desde la API de Kamshub 🚀"*
  - Mensaje **recibido en chat de Telegram** por el usuario
  - `providerMessageId` real devuelto (no `null`) [web:2926][file:3014]

**Technical Notes**

- Un bot de Telegram puede manejar **múltiples conversaciones simultáneas**:
  - Cada usuario tiene un `chat.id` único (el `externalThreadId`)
  - Un solo canal (`channelId`) puede tener N conversaciones
  - Aislamiento garantizado por índice único `(tenantId, channelId, externalThreadId)` [file:3004]
  
- Para múltiples bots por tenant:
  - Crear bot adicional en BotFather
  - Insertar nuevo documento en `channels` con `botToken` diferente
  - Configurar webhook con nuevo `channelId`
  - Cada bot opera independientemente [web:3006]

- Función `sendTelegramMessage` diferencia tokens:
  - Si `botToken` empieza con `TEST_`: modo mock (no llama API)
  - Si no: llama a Telegram API real con `chat_id` de `conversation.externalThreadId` [file:2656]

**Security & Operations**

- Token del bot guardado en MongoDB (dev):
  - ⚠️ Para producción: migrar a AWS Secrets Manager o encriptar en MongoDB
  - Token nunca debe exponerse en logs o repos públicos [web:3010][web:3012]

- Webhook verification:
  - `getWebhookInfo` confirma URL configurada y `pending_update_count: 0`
  - CloudWatch Logs en `/aws/lambda/kamshub-msg-dev-api` para debugging [web:2907]

**Next Steps (Post Bot Real)**

- [ ] Spec de UI mínima (inbox + chat view)
- [ ] Agregar Meta Messenger como segundo canal
- [ ] Implementar outbox + retry logic con SQS
- [ ] Migrar tokens a Secrets Manager (prod)

### 2026-01-13 – UI Spec / Wireframes (Inbox + Chat)

**Objective**

Define las pantallas principales del MVP y validar que los endpoints actuales proporcionan todos los campos necesarios para la UI, sin escribir código de frontend todavía.

**Screens Defined**

1. **Inbox / Lista de conversaciones** (`/inbox`)
   - Card por conversación con:
     - Icono del canal (🟦 telegram, 💬 messenger)
     - Nombre del canal (`channel.displayName`)
     - Participante (`participants[0].externalUsername`)
     - Preview último mensaje (`lastMessagePreview`, truncado ~50 chars)
     - Timestamp humanizado (`lastMessageAt`: "2 hours ago", "Yesterday")
     - Badge de no leídos (`unreadCount`, destacado si > 0)
   - Ordenado por `lastMessageAt` desc
   - Click en card → navega a `/conversations/{id}`
   - Endpoint: `GET /tenant/conversations`

2. **Vista de conversación / Chat** (`/conversations/{id}`)
   - Header:
     - Icono + tipo + nombre del canal
     - Username del participante + Chat ID (`externalThreadId`)
   - Mensajes:
     - Burbujas izquierda (`direction: inbound`, gris)
     - Burbujas derecha (`direction: outbound`, azul)
     - Texto + timestamp (`createdAt` formato hora)
     - Auto-scroll al último mensaje
   - Input:
     - Textarea "Type a message..."
     - Botón "Send" (disabled si vacío)
     - Optimistic update al enviar
   - Endpoints:
     - `GET /tenant/conversations/{id}/messages` (historial)
     - `POST /tenant/conversations/{id}/messages` (enviar)

3. **Header de conversación**
   - Datos incluidos en response de `GET /conversations/{id}/messages`
   - `conversation.channel.{type, displayName}`
   - `conversation.participants[0].externalUsername`
   - `conversation.externalThreadId`

**Field Validation**

| Elemento UI | Campo API | Estado |
|------------|-----------|--------|
| Icono canal | `channel.type` | ✅ Disponible |
| Nombre canal | `channel.displayName` | ✅ Disponible |
| Badge no leídos | `unreadCount` | ⚠️ Placeholder (siempre 0) |
| Participante | `participants[0].externalUsername` | ✅ Disponible |
| Preview mensaje | `lastMessagePreview` | ✅ Disponible |
| Timestamp conversación | `lastMessageAt` | ✅ Disponible |
| Lista mensajes | `items[]` | ✅ Disponible |
| Texto mensaje | `text` | ✅ Disponible |
| Dirección mensaje | `direction` | ✅ Disponible |
| Timestamp mensaje | `createdAt` | ✅ Disponible |
| Chat ID externo | `externalThreadId` | ✅ Disponible |

**Gaps Identified (Non-blocking for MVP)**

- `unreadCount` es placeholder: requiere tracking de "último mensaje leído por agente"
- No hay estado de entrega de mensajes outbound (pending, delivered, read, failed)
- Paginación de mensajes: `nextCursor` siempre `null` (funciona para pocas conversaciones)

**Decision**

Todos los campos críticos están disponibles en los endpoints actuales. La UI puede implementarse completamente con la API existente. Los gaps documentados se implementarán post-MVP cuando haya tráfico real.

**Next Steps**

- [ ] Agregar Meta Messenger como segundo canal
- [ ] Implementar frontend (React/Vue) con estos contratos
- [ ] Post-MVP: tracking de lectura para `unreadCount` real
