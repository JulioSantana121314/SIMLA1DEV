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
  await mongoClient.connect(); // se reutiliza entre invocaciones en Lambda [web:2854][web:2859]
  mongoDb = mongoClient.db(MONGODB_DB_NAME);
  return mongoDb;
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
  if (!auth.roles.some(r => allowedRoles.includes(r))) {
    throw new Error('Forbidden: insufficient role');
  }
}

async function bootstrap(event) {
  const { email, tempPassword } = JSON.parse(event.body);
  
  // Generar username alfanumérico único
  const username = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + '_' + Date.now();
  
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'custom:tenantID', Value: 'platform' },
    ],
    TemporaryPassword: tempPassword,
    MessageAction: 'SUPPRESS',
  }));
  
  await cognito.send(new AdminAddUserToGroupCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    GroupName: 'platform_admin',
  }));
  
  return { statusCode: 201, body: JSON.stringify({ ok: true, message: 'Platform admin created', email, username }) };
}

async function createTenant(event) {
  const auth = await verifyJwt(event);
  requireRole(auth, ['platform_admin']);
  
  const { tenantName, adminEmail, tempPassword } = JSON.parse(event.body);
  const tenantId = randomUUID();
  
  // Generar username alfanumérico único
  const username = adminEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + '_' + Date.now();
  
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'email', Value: adminEmail },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'custom:tenantID', Value: tenantId },
    ],
    TemporaryPassword: tempPassword,
    MessageAction: 'SUPPRESS',
  }));
  
  await cognito.send(new AdminAddUserToGroupCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    GroupName: 'tenant_admin',
  }));
  
  return { statusCode: 201, body: JSON.stringify({ ok: true, tenantId, adminEmail, username }) };
}

async function createChannel(event) {
  const auth = await verifyJwt(event);
  // Solo tenants y plataforma pueden crear canales
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
    tenantId: auth.tenantId,          // siempre desde el token, nunca del body [web:2845]
    type,
    displayName,
    externalId,
    credentials,                      // TODO: encriptar en siguiente iteración
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  const result = await channels.insertOne(doc); // [web:2850][web:2862]

  return {
    statusCode: 201,
    body: JSON.stringify({
      id: result.insertedId.toString(),
      ...doc,
    }),
  };
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

export const handler = async (event) => {
  const { rawPath, requestContext } = event;
  const method = requestContext?.http?.method || event.httpMethod;

  try {
    // AUTH
    if (method === 'POST' && rawPath === '/auth/login') {
      return await login(event);
    }
    if (method === 'POST' && rawPath === '/auth/complete-new-password') {
      return await completeNewPassword(event);
    }

    // PLATFORM
    if (method === 'POST' && rawPath === '/platform/bootstrap') return await bootstrap(event);
    if (method === 'POST' && rawPath === '/platform/tenants') return await createTenant(event);

    // TENANT
    if (method === 'POST' && rawPath === '/tenant/channels') return await createChannel(event);

    // ME
    if (method === 'GET' && rawPath === '/me') return await getMe(event);

    return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
  } catch (err) {
    console.error(err);
    const msg = err.message || 'Internal error';
    const statusCode = msg.includes('Forbidden')
      ? 403
      : msg.includes('Authorization')
      ? 401
      : 500;
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

  const res = await cognito.send(cmd); // [web:2799]

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

  const res = await cognito.send(cmd); // [web:2771]

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
