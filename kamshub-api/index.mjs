import { MongoClient } from 'mongodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminInitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'crypto';

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const cognito = new CognitoIdentityProviderClient({ region: 'us-east-2' });
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'kamshub_msg_dev';

console.log('ENV', { USER_POOL_ID, CLIENT_ID, MONGODB_URI_PRESENT: !!MONGODB_URI, MONGODB_DB_NAME });

let mongoClient;
let mongoDb;

async function getDb() {
  if (mongoDb) return mongoDb;

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI not configured');
  }

  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  mongoDb = mongoClient.db(MONGODB_DB_NAME);
  return mongoDb;
}

function getConversationsCollection(db) {
  return db.collection('conversations');
}

function getMessagesCollection(db) {
  return db.collection('messages');
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'id',
  clientId: CLIENT_ID,
});

async function verifyJwt(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }

  const token = authHeader.substring(7);
  const payload = await verifier.verify(token);

  return {
    userId: payload.sub,
    email: payload.email,
    tenantId: payload['custom:tenantID'] || null,
    roles: payload['cognito:groups'] || [],
  };
}

function requireRole(auth, allowedRoles) {
  if (!auth.roles.some((r) => allowedRoles.includes(r))) {
    throw new Error('Forbidden: insufficient role');
  }
}

async function bootstrap(event) {
  const { email, tempPassword } = JSON.parse(event.body);

  const username = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + '_' + Date.now();

  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:tenantID', Value: 'platform' },
      ],
      TemporaryPassword: tempPassword,
      MessageAction: 'SUPPRESS',
    }),
  );

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: 'platform_admin',
    }),
  );

  return {
    statusCode: 201,
    body: JSON.stringify({ ok: true, message: 'Platform admin created', email, username }),
  };
}

async function createTenant(event) {
  const auth = await verifyJwt(event);
  requireRole(auth, ['platform_admin']);

  const { tenantName, adminEmail, tempPassword } = JSON.parse(event.body);
  const tenantId = randomUUID();

  const username = adminEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + '_' + Date.now();

  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      UserAttributes: [
        { Name: 'email', Value: adminEmail },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:tenantID', Value: tenantId },
      ],
      TemporaryPassword: tempPassword,
      MessageAction: 'SUPPRESS',
    }),
  );

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: 'tenant_admin',
    }),
  );

  return { statusCode: 201, body: JSON.stringify({ ok: true, tenantId, adminEmail, username }) };
}

async function createChannel(event) {
  const auth = await verifyJwt(event);
  requireRole(auth, ['tenant_admin', 'tenant_manager', 'platform_admin']);

  const { type, displayName, externalId, credentials } = JSON.parse(event.body || '{}');

  if (!type || !displayName || !externalId || !credentials) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'type, displayName, externalId and credentials are required' }),
    };
  }

  if (!['telegram', 'messenger'].includes(type)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'type must be telegram or messenger' }),
    };
  }

  const db = await getDb();
  const channels = db.collection('channels');

  const now = new Date().toISOString();
  const doc = {
    tenantId: auth.tenantId,
    type,
    displayName,
    externalId,
    credentials,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  const result = await channels.insertOne(doc);

  return {
    statusCode: 201,
    body: JSON.stringify({
      id: result.insertedId.toString(),
      ...doc,
    }),
  };
}

async function findOrCreateConversation({ tenantId, channelId, externalThreadId, participants = {} }) {
  const db = await getDb();
  const conversations = getConversationsCollection(db);

  const now = new Date().toISOString();

  // 1) intentar encontrar conversación existente
  let conversation = await conversations.findOne({
    tenantId,
    channelId,
    externalThreadId,
  });

  if (conversation) {
    await conversations.updateOne(
      { _id: conversation._id },
      {
        $set: {
          lastMessageAt: now,
          updatedAt: now,
        },
      },
    );
    return conversation;
  }

  // 2) crear nueva conversación
  const doc = {
    tenantId,
    channelId,
    externalThreadId,
    participants,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const result = await conversations.insertOne(doc);
  doc._id = result.insertedId;
  return doc;
}

async function insertMessage({
  tenantId,
  channelId,
  conversationId,
  direction,
  provider,
  providerMessageId,
  text,
  raw,
}) {
  const db = await getDb();
  const messages = getMessagesCollection(db);

  const now = new Date().toISOString();

  const doc = {
    tenantId,
    channelId,
    conversationId,
    direction,
    provider,
    providerMessageId,
    text,
    raw: raw || null,
    createdAt: now,
  };

  await messages.insertOne(doc);

  return doc;
}

async function getMe(event) {
  const auth = await verifyJwt(event);
  return {
    statusCode: 200,
    body: JSON.stringify({
      userId: auth.userId,
      email: auth.email,
      tenantId: auth.tenantId,
      roles: auth.roles,
    }),
  };
}

async function telegramWebhook(event) {
  const { rawPath } = event;

  const match = rawPath.match(/^\/webhooks\/telegram\/([a-fA-F0-9]{24})$/);
  if (!match) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Telegram webhook path' }) };
  }

  const channelId = match[1];

  const db = await getDb();
  const channels = db.collection('channels');

  const { ObjectId } = await import('mongodb');
  const channel = await channels.findOne({ _id: new ObjectId(channelId) });

  if (!channel) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Channel not found' }) };
  }

  const tenantId = channel.tenantId;

  let update;
  try {
    update = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const message = update.message || update.edited_message;
  if (!message) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: true }) };
  }

  const externalThreadId = String(message.chat?.id ?? '');
  const providerMessageId = String(message.message_id ?? '');
  const text = message.text || '';

  if (!externalThreadId || !providerMessageId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing chat.id or message_id in Telegram payload' }) };
  }

  const participants = {
    externalUserId: message.from?.id ? String(message.from.id) : undefined,
    externalUsername: message.from?.username || undefined,
  };

  console.log('TG WEBHOOK - findOrCreateConversation input', {
    tenantId,
    channelId,
    externalThreadId,
    participants,
  });

  const conversation = await findOrCreateConversation({
    tenantId,
    channelId: channelId,
    externalThreadId,
    participants,
  });

  console.log(
    'TG WEBHOOK - conversation result',
    conversation && {
      _id: conversation._id,
      tenantId: conversation.tenantId,
      channelId: conversation.channelId,
      externalThreadId: conversation.externalThreadId,
    },
  );

  if (!conversation || !conversation._id) {
    console.error('TG WEBHOOK - conversation has no _id', conversation);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Conversation missing _id' }),
    };
  }

  await insertMessage({
    tenantId,
    channelId: channelId,
    conversationId: conversation._id,
    direction: 'inbound',
    provider: 'telegram',
    providerMessageId,
    text,
    raw: update,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true }),
  };
}

export const handler = async (event) => {
  const { rawPath, requestContext } = event;
  const method = requestContext?.http?.method || event.httpMethod;

  try {
    if (method === 'POST' && rawPath === '/auth/login') {
      return await login(event);
    }
    if (method === 'POST' && rawPath === '/auth/complete-new-password') {
      return await completeNewPassword(event);
    }
    if (method === 'POST' && rawPath === '/platform/bootstrap') return await bootstrap(event);
    if (method === 'POST' && rawPath === '/platform/tenants') return await createTenant(event);
    if (method === 'POST' && rawPath === '/tenant/channels') return await createChannel(event);
    if (method === 'POST' && rawPath.startsWith('/webhooks/telegram/')) {
      return await telegramWebhook(event);
      }
    if (method === 'GET' && rawPath === '/me') return await getMe(event);
    if (method === 'GET' && rawPath === '/tenant/conversations') {
      return await listConversations(event);
      }


    return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
  } catch (err) {
    console.error(err);
    const msg = err.message || 'Internal error';
    const statusCode = msg.includes('Forbidden') ? 403 : msg.includes('Authorization') ? 401 : 500;
    return { statusCode, body: JSON.stringify({ error: msg }) };
  }
};

async function login(event) {
  const { email, password } = JSON.parse(event.body || '{}');

  if (!email || !password) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'email and password are required' }),
    };
  }

  const cmd = new AdminInitiateAuthCommand({
    UserPoolId: USER_POOL_ID,
    ClientId: CLIENT_ID,
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  });

  const res = await cognito.send(cmd);

  if (res.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    return {
      statusCode: 200,
      body: JSON.stringify({
        challenge: 'NEW_PASSWORD_REQUIRED',
        session: res.Session,
      }),
    };
  }

  const auth = res.AuthenticationResult;
  if (!auth) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Authentication failed' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      accessToken: auth.AccessToken,
      idToken: auth.IdToken,
      refreshToken: auth.RefreshToken,
      expiresIn: auth.ExpiresIn,
      tokenType: auth.TokenType,
    }),
  };
}

async function completeNewPassword(event) {
  const { email, newPassword, session } = JSON.parse(event.body || '{}');

  if (!email || !newPassword || !session) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'email, newPassword and session are required' }),
    };
  }

  const cmd = new RespondToAuthChallengeCommand({
    ClientId: CLIENT_ID,
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    Session: session,
    ChallengeResponses: {
      USERNAME: email,
      NEW_PASSWORD: newPassword,
    },
  });

  const res = await cognito.send(cmd);

  const auth = res.AuthenticationResult;
  if (!auth) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Challenge failed' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      accessToken: auth.AccessToken,
      idToken: auth.IdToken,
      refreshToken: auth.RefreshToken,
      expiresIn: auth.ExpiresIn,
      tokenType: auth.TokenType,
    }),
  };
}

async function listConversations(event) {
  const auth = await verifyJwt(event);

  const db = await getDb();
  const conversationsCol = getConversationsCollection(db);
  const channelsCol = db.collection('channels');
  const messagesCol = getMessagesCollection(db);
  const { ObjectId } = await import('mongodb');

  const rawLimit = event.queryStringParameters?.limit || '20';
  const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 20, 1), 100);

  const conversations = await conversationsCol
    .find({ tenantId: auth.tenantId })
    .sort({ lastMessageAt: -1 })
    .limit(limit)
    .toArray();

  if (!conversations.length) {
    return {
      statusCode: 200,
      body: JSON.stringify({ items: [], nextCursor: null }),
    };
  }

  const channelIds = [...new Set(conversations.map((c) => c.channelId))];
  const channels = await channelsCol
    .find({ _id: { $in: channelIds.map((id) => new ObjectId(id)) } })
    .project({ type: 1, displayName: 1 })
    .toArray();
  const channelById = new Map(channels.map((ch) => [ch._id.toString(), ch]));

  const conversationIds = conversations.map((c) => c._id);
  const lastMessages = await messagesCol
    .aggregate([
      { $match: { tenantId: auth.tenantId, conversationId: { $in: conversationIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$conversationId',
          text: { $first: '$text' },
          createdAt: { $first: '$createdAt' },
        },
      },
    ])
    .toArray();
  const lastMessageByConvId = new Map(
    lastMessages.map((m) => [m._id.toString(), m]),
  );

  const items = conversations.map((c) => {
    const ch = channelById.get(c.channelId.toString());
    const lastMsg = lastMessageByConvId.get(c._id.toString());

    return {
      id: c._id.toString(),
      tenantId: c.tenantId,
      channel: ch
        ? {
            id: c.channelId,
            type: ch.type,
            displayName: ch.displayName,
          }
        : {
            id: c.channelId,
            type: null,
            displayName: null,
          },
      externalThreadId: c.externalThreadId,
      participants: c.participants || {},
      lastMessagePreview: lastMsg?.text || null,
      lastMessageAt: c.lastMessageAt || lastMsg?.createdAt || null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      unreadCount: 0,
    };
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ items, nextCursor: null }),
  };
}
