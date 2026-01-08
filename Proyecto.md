# Kamshub Messaging Platform — Project Documentation (Living Doc)

**Last updated:** 2025-12-31 18:36 UTC

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
- `kamshub-msg-dev-webhook` (Function URL / HTTP endpoint): receives inbound events and enqueues to `incoming.fifo`.
- `kamshub-msg-dev-processor`: consumes from `incoming.fifo`, persists/normalizes/dedupes, and writes outbox/send-requests.
- `kamshub-msg-dev-sender`: consumes from `send.fifo` and sends outbound messages to the external channel APIs.

SQS event source mapping:
- `ReportBatchItemFailures = true`.
- `BatchSize` small during debugging (often 1).

---

## 3) High-level architecture
### 3.1 Inbound pipeline
1) External provider webhook → Lambda `...-webhook` (Function URL)
2) `...-webhook` validates basic request + parses payload
3) `...-webhook` publishes to `incoming.fifo`
4) `...-processor` consumes, normalizes and performs idempotent processing
5) `...-processor` writes to MongoDB (events/messages/conversations) and creates outbox items

### 3.2 Outbound pipeline
1) `...-processor` (or API/UI action) creates Outbox record (durable)
2) Dispatcher publishes to `send.fifo` (or sender pulls pending outbox)
3) `...-sender` sends to Telegram/Messenger API
4) Sender marks outbox item as SENT (or FAILED with retry metadata)

---

## 4) Data integrity patterns
### 4.1 Reality: delivery is at-least-once
Webhooks + queues can deliver duplicates; the system must assume duplicates can happen.

### 4.2 Inbox / Idempotent Consumer (Inbound)
- Persist inbound events and dedupe using a unique key:
  - Prefer provider’s immutable `eventId`/`externalMessageId`.
- Maintain state per inbound event (example): `RECEIVED → PROCESSING → PROCESSED` (or `FAILED`).

### 4.3 Outbox (Outbound)
- Never rely on “DB write + send” as two loose steps.
- Create a durable outbox item first; retries read from outbox state.
- Maintain outbound dedupe keys (`sendId`) to avoid double-sends.

---

## 5) FIFO ordering & concurrency
Design target:
- Preserve order **within a conversation**.
- Allow parallelism **across conversations**.

Guideline:
- `MessageGroupId` should be derived from `(tenantId, conversationId)` (or a stable conversation key).

Deduplication:
- Prefer `MessageDeduplicationId = providerEventId` (stable) rather than random UUID (random disables practical dedupe).

---

## 6) Multi-tenancy model
### 6.1 Tenant definition
- Tenant represents a company/organization.
- All resources are owned by exactly one tenant.

### 6.2 Tenant isolation requirements
- Every query/write must include `tenantId` filtering.
- Every object-level endpoint must enforce `resource.tenantId == auth.tenantId`.

### 6.3 Roles (MVP)
- `platform_admin`: platform-level operations (dangerous actions).
- `tenant_admin`: full permissions within tenant.
- `tenant_manager`: limited admin within tenant (rename/activate/deactivate channels; operate inbox).

MVP decision: **roles are enough initially** (no per-user conversation assignment/visibility rules yet).

---

## 7) Authentication & authorization (Recommended)
### 7.1 Choice
Use **Amazon Cognito User Pools**.

### 7.2 Cognito model (single pool, multi-tenant via claim)
- One user pool shared across tenants.
- Add custom attribute: `custom:tenantID`.
- Users belong to exactly one tenant.
- Roles can be represented as Cognito Groups or a custom claim.

### 7.3 API enforcement
- All API requests validate JWT and derive:
  - `auth.tenantId` from token claim
  - `auth.role`
- Enforce RBAC + object-level authorization.

---

## 8) Channel connectors
### 8.1 Channel entity
Minimum fields:
- `tenantId`
- `type`: `telegram` | `messenger`
- `displayName`
- `externalId`:
  - Telegram: bot username or bot id
  - Messenger: pageId
- `encryptedCredentials`:
  - Telegram: bot token
  - Messenger: page access token (+ metadata)
- `isActive` boolean

Behavior:
- If `isActive=false`, inbound events may still be ingested but hidden from inbox until reactivated.

### 8.2 Telegram multi-bot
- One webhook per bot.
- Support many bots pointing to same domain using distinct routes:
  - `/webhooks/telegram/{{channelId}}`

### 8.3 Messenger multi-page
- OAuth login grants access to pages.
- Backend lists pages (e.g., via `/me/accounts`) and stores selected Page Access Tokens.
- Subscribe app/page to webhooks for receiving messages.

---

## 9) MongoDB (planned collections)
### 9.1 Core
- `tenants`
- `users` (may mirror Cognito userId + role + tenantId)
- `channels`
- `conversations`
- `messages`

### 9.2 Integrity & operations
- `inbound_events` (raw + normalized metadata)
- `processed_events` or unique index on `inbound_events` for idempotency
- `outbox_send`
- `send_log` (dedupe + audit)
- `audit_log` / `system_ledger`

Indices (typical):
- Unique `(tenantId, externalMessageId)` for messages.
- Unique `(tenantId, channelId, externalThreadId)` for conversations.
- Unique `(tenantId, outboxId)` or `(tenantId, sendId)` for outbound.

---

## 10) Platform operations
### 10.1 Tenant lifecycle
Tenant statuses:
- `Active`
- `Blocked`
- `DeletionScheduled` (soft state + future purge)

Deletion:
- Grace period is configurable (default 15 days) but **only platform_admin** can change it.
- Purge job hard-deletes tenant data and credentials.

### 10.2 Debug raw capture (per-tenant)
Controlled only by `platform_admin`.
Suggested fields:
- `rawCaptureMode`: `off | sample | always`
- `rawSampleRate`
- `rawTtlDays`
- `rawAlwaysUntil` (auto-expire)

Decision: when `always` expires, fallback goes to **off**.

---

## 11) Environments
Recommended: separate **staging** and **prod**.
- Tenant “Testing” should live in staging (not prod) to avoid contamination.

---

## 12) MVP definition (acceptance)
MVP is done when:
1) Multi-tenant auth works (users in one tenant).
2) A tenant can connect **multiple** Telegram bots and **multiple** Messenger pages.
3) System can receive inbound messages from any connected channel.
4) System can send outbound messages through the correct channel.
5) Ordering is preserved per conversation and duplicates don’t duplicate domain effects.
6) DLQs and redrive exist and can be operated.

---

## 13) Roadmap / next steps (implementation order)
1) Create Cognito User Pool + `custom:tenantID` + role model (groups/claim).
2) Build Tenant onboarding API:
   - Create tenant
   - Create first tenant admin user
   - Create platform_admin bootstrap path
3) Implement core Mongo models + indices for tenant isolation and idempotency.
4) Implement `/tenant/channels` APIs:
   - Create/rename/activate/deactivate
   - Telegram connector (setWebhook/removeWebhook)
   - Messenger connector (OAuth + page selection + webhook subscription)
5) Implement normalized message contract + processor logic.
6) Implement outbox + sender logic per channel.
7) Build minimal admin UI later (not required now).

---

## 14) Changelog
- 2025-12-31: Created first consolidated living documentation file; captured MVP scope, AWS dev footprint, multi-tenant + Cognito decision, and roadmap.

2025-12-31: Decidido usar 1 Cognito User Pool compartido con custom:tenantID (usuario pertenece a un solo tenant) y roles iniciales sin asignación de chats por usuario.
​
## [2026-01-07] - Cognito User Pool + Lambda API Bootstrap

### Added
- **AWS Cognito User Pool** configurado en `us-east-2`
  - User Pool ID: `us-east-2_B9izGWtvy`
  - Client ID: `6dv32jfp4vra4l3ttn5kqpm31d`
  - Sign-in: Email + Username
  - Self-registration: Disabled (solo platform_admin crea usuarios)
  - Custom attribute: `custom:tenantID` (String, immutable, max 36 chars)
  - Grupos: `platform_admin`, `tenant_admin`, `tenant_manager`
  - Authentication flows: ALLOW_USER_PASSWORD_AUTH, ALLOW_ADMIN_USER_PASSWORD_AUTH, ALLOW_REFRESH_TOKEN_AUTH

- **Lambda Function** `kamshub-msg-dev-api` (Node.js 24.x, us-east-2)
  - Function URL: `https://5ewhj564xzelbmiusggtp6qiva0mvott.lambda-url.us-east-2.on.aws/`
  - Endpoints implementados:
    - `POST /platform/bootstrap`: Crear primer platform_admin (público, sin autenticación)
    - `POST /platform/tenants`: Crear tenant + tenant_admin (requiere platform_admin role)
    - `GET /me`: Obtener info del usuario autenticado (requiere JWT válido)
  - Middleware JWT: Verificación de ID tokens con `aws-jwt-verify` v4.0.1
  - Role-based authorization: Función `requireRole()` valida permisos por grupo
  - Username generation: Genera usernames alfanuméricos únicos (formato: `{emailPrefix}_{timestamp}`) para evitar conflicto con email alias

- **IAM Policy** `CognitoAdminAccess` para Lambda role
  - Permisos: AdminCreateUser, AdminAddUserToGroup, AdminUpdateUserAttributes, DescribeUserPool, ListUsers
  - Resource: `arn:aws:cognito-idp:us-east-2:856716755654:userpool/us-east-2_B9izGWtvy`

- **Dependencies** para Lambda
  - `aws-jwt-verify`: ^4.0.1 (verificación de ID tokens)
  - `@aws-sdk/client-cognito-identity-provider`: ^3.700.0 (admin operations)

### Configuration
- Lambda timeout: 10 seconds
- Lambda memory: 128 MB
- Environment variables:
  - `COGNITO_USER_POOL_ID`: us-east-2_B9izGWtvy
  - `COGNITO_CLIENT_ID`: 6dv32jfp4vra4l3ttn5kqpm31d
  - `AWS_REGION_COGNITO`: us-east-2

### Security
- User Pool attribute `custom:tenantID` configurado como immutable (no puede ser modificado por usuarios ni app clients)
- Function URL sin auth (autenticación manejada en código con JWT verification)
- Groups en ID token: aparecen automáticamente en claim `cognito:groups`

### Technical Notes
- User Pool configurado con email alias: usernames generados programáticamente, login con email
- JWT verification usa JWKS endpoint: `https://cognito-idp.us-east-2.amazonaws.com/us-east-2_B9izGWtvy/.well-known/jwks.json`
- Temporary passwords: generadas por platform_admin, usuarios deben cambiar en primer login
- MessageAction: SUPPRESS (no se envían emails de bienvenida; MVP sin SES configurado)

### Next Steps
- [ ] Crear primer platform_admin vía `/platform/bootstrap`
- [ ] Implementar endpoint `POST /auth/login` (InitiateAuth flow)
- [ ] Implementar endpoint `POST /auth/change-password` (responder NEW_PASSWORD_REQUIRED challenge)
- [ ] Agregar MongoDB para persistir tenants (actualmente solo se crea en Cognito)
- [ ] Implementar endpoints CRUD para channels, templates, inbox
- [ ] Configurar AWS SES para emails de Cognito (opcional para producción)

