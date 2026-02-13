import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getConversations } from '../services/api';
import ConversationList from '../components/ConversationList';
import ChatView from '../components/ChatView';
import EmptyState from '../components/EmptyState';
import './Inbox.css';

export default function Inbox() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadConversations();
  }, []);

  const loadConversations = async () => {
    try {
      setLoading(true);
      const data = await getConversations();
      setConversations(data.items || []);
      
      // Auto-seleccionar la primera conversación
      if (data.items && data.items.length > 0 && !selectedConversationId) {
        setSelectedConversationId(data.items[0].id);
      }
    } catch (err) {
      console.error('Error loading conversations:', err);
      setError('Failed to load conversations');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.clear();
    navigate('/');
  };

  const handleConversationSelect = (conversationId) => {
    setSelectedConversationId(conversationId);
  };

  const selectedConversation = conversations.find(
    (c) => c.id === selectedConversationId
  );

  return (
    <div className="inbox-container">
      {/* Header */}
      <div className="inbox-header">
        <h1 className="inbox-title">Kamshub Inbox</h1>
        <button onClick={handleLogout} className="logout-button">
          Logout
        </button>
      </div>

      {/* Main Content */}
      <div className="inbox-main-content">
        {/* Sidebar: Lista de conversaciones */}
        <ConversationList
          conversations={conversations}
          selectedId={selectedConversationId}
          onSelect={handleConversationSelect}
          loading={loading}
          error={error}
        />

        {/* Chat Area */}
        {selectedConversation ? (
          <ChatView
            conversation={selectedConversation}
            onMessageSent={loadConversations}
          />
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}
