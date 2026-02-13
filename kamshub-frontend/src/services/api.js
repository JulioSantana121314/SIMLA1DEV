import axios from 'axios';

const API_BASE_URL = 'https://5ewhj564xzelbmiusggtp6qiva0mvott.lambda-url.us-east-2.on.aws';
const CLIENT_ID = '2ua96l1gdgjbaiil9kj798pvf';

// ============================================
// Crear instancia de axios
// ============================================
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ============================================
// Interceptor REQUEST: Agregar token automáticamente
// ============================================
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('idToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ============================================
// Interceptor RESPONSE: Auto-refresh en 401
// ============================================
api.interceptors.response.use(
  (response) => response, // Si la respuesta es exitosa, no hace nada
  async (error) => {
    const originalRequest = error.config;

    // Si es 401 y no hemos intentado refrescar aún
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        console.log('Token expirado, refrescando...');

        const refreshToken = localStorage.getItem('refreshToken');

        if (!refreshToken) {
          throw new Error('No refresh token available');
        }

        // Llamar a Cognito para refrescar el token
        const response = await fetch('https://cognito-idp.us-east-2.amazonaws.com/', {
          method: 'POST',
          headers: {
            'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
            'Content-Type': 'application/x-amz-json-1.1',
          },
          body: JSON.stringify({
            ClientId: CLIENT_ID,
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            AuthParameters: {
              REFRESH_TOKEN: refreshToken
            }
          })
        });

        if (!response.ok) {
          throw new Error('Failed to refresh token');
        }

        const data = await response.json();
        const newIdToken = data.AuthenticationResult.IdToken;
        const newAccessToken = data.AuthenticationResult.AccessToken;

        // Guardar los nuevos tokens
        localStorage.setItem('idToken', newIdToken);
        localStorage.setItem('accessToken', newAccessToken);

        console.log('Token refrescado exitosamente');

        // Actualizar el header de la request original con el nuevo token
        originalRequest.headers.Authorization = `Bearer ${newIdToken}`;

        // Reintentar la request original
        return api(originalRequest);
      } catch (refreshError) {
        console.error('Error al refrescar token:', refreshError);

        // Si falla el refresh, limpiar storage y redirigir a login
        localStorage.clear();
        window.location.href = '/';
        return Promise.reject(refreshError);
      }
    }

    // Si no es 401 o ya intentamos refrescar, rechazar el error
    return Promise.reject(error);
  }
);

// ============================================
// Auth
// ============================================
export const login = async (email, password) => {
  const response = await axios.post(`${API_BASE_URL}/auth/login`, {
    email,
    password,
  });

  const data = response.data;

  // Si requiere cambio de password, retornar sin guardar tokens
  if (data.challenge === 'NEW_PASSWORD_REQUIRED') {
    return data;
  }

  // Guardar tokens en localStorage
  if (data.idToken) {
    localStorage.setItem('idToken', data.idToken);
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    console.log('Tokens guardados correctamente');
  }

  return data;
};

export const completeNewPassword = async (email, newPassword, session) => {
  const response = await axios.post(`${API_BASE_URL}/auth/complete-new-password`, {
    email,
    newPassword,
    session,
  });

  const data = response.data;

  // Guardar tokens después de cambiar password
  if (data.idToken) {
    localStorage.setItem('idToken', data.idToken);
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    console.log('Tokens guardados después de cambio de contraseña');
  }

  return data;
};

// ============================================
// Conversations
// ============================================
export const getConversations = async () => {
  const response = await api.get('/tenant/conversations');
  return response.data;
};

export const getConversationMessages = async (conversationId) => {
  const response = await api.get(`/tenant/conversations/${conversationId}/messages`);
  return response.data;
};

export const sendMessage = async (conversationId, text) => {
  const response = await api.post(`/tenant/conversations/${conversationId}/messages`, {
    text,
  });
  return response.data;
};

export default api;
