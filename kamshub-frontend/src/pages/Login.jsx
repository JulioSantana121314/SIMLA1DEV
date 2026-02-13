import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, completeNewPassword } from '../services/api';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(email, password);

      if (result.challenge === 'NEW_PASSWORD_REQUIRED') {
        setSession(result.session);
        setLoading(false);
        return;
      }

      // Login exitoso
      localStorage.setItem('idToken', result.idToken);
      localStorage.setItem('accessToken', result.accessToken);
      navigate('/inbox');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
      setLoading(false);
    }
  };

  const handleCompletePassword = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await completeNewPassword(email, newPassword, session);
      localStorage.setItem('idToken', result.idToken);
      localStorage.setItem('accessToken', result.accessToken);
      navigate('/inbox');
    } catch (err) {
      setError(err.response?.data?.error || 'Password change failed');
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Kamshub</h1>
        <p style={styles.subtitle}>Multi-channel messaging platform</p>

        {error && <div style={styles.error}>{error}</div>}

        {!session ? (
          <form onSubmit={handleLogin} style={styles.form}>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={styles.input}
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              required
            />
            <button type="submit" style={styles.button} disabled={loading}>
              {loading ? 'Loading...' : 'Login'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleCompletePassword} style={styles.form}>
            <p style={styles.info}>Please set a new password</p>
            <input
              type="password"
              placeholder="New Password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              style={styles.input}
              required
            />
            <button type="submit" style={styles.button} disabled={loading}>
              {loading ? 'Loading...' : 'Set Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    backgroundColor: '#f5f5f5',
  },
  card: {
    backgroundColor: 'white',
    padding: '40px',
    borderRadius: '8px',
    boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
    width: '100%',
    maxWidth: '400px',
  },
  title: {
    fontSize: '32px',
    fontWeight: 'bold',
    marginBottom: '8px',
    textAlign: 'center',
    color: '#333',
  },
  subtitle: {
    fontSize: '14px',
    color: '#666',
    textAlign: 'center',
    marginBottom: '32px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  input: {
    padding: '12px',
    fontSize: '14px',
    border: '1px solid #ddd',
    borderRadius: '4px',
    outline: 'none',
  },
  button: {
    padding: '12px',
    fontSize: '14px',
    fontWeight: 'bold',
    backgroundColor: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  error: {
    padding: '12px',
    backgroundColor: '#fee',
    color: '#c33',
    borderRadius: '4px',
    marginBottom: '16px',
    fontSize: '14px',
  },
  info: {
    color: '#666',
    fontSize: '14px',
    marginBottom: '8px',
  },
};
