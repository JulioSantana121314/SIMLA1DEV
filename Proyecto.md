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
