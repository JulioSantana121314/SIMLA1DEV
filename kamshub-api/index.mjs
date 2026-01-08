import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'crypto';

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const cognito = new CognitoIdentityProviderClient({ region: 'us-east-2' });

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
    if (method === 'POST' && rawPath === '/platform/bootstrap') return await bootstrap(event);
    if (method === 'POST' && rawPath === '/platform/tenants') return await createTenant(event);
    if (method === 'GET' && rawPath === '/me') return await getMe(event);
    
    return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
  } catch (err) {
    console.error(err);
    const statusCode = err.message.includes('Forbidden') ? 403 : (err.message.includes('Authorization') ? 401 : 500);
    return { statusCode, body: JSON.stringify({ error: err.message }) };
  }
};
