import { useState, useEffect, useRef } from 'react';
import { getConversationMessages, sendMessage } from '../services/api';
import './ChatView.css';

export default function ChatView({ conversation, onMessageSent }) {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    loadMessages();
  }, [conversation.id]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const loadMessages = async () => {
    try {
      setLoading(true);
      const data = await getConversationMessages(conversation.id);
      setMessages(data.items || []);
    } catch (err) {
      console.error('Error loading messages:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    const text = newMessage.trim();
    if (!text || sending) return;

    try {
      setSending(true);
      await sendMessage(conversation.id, text);
      
      setNewMessage('');
      await loadMessages();
      
      if (onMessageSent) {
        onMessageSent();
      }
    } catch (err) {
      console.error('Error sending message:', err);
      alert('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="chat-container">
      {/* Chat Header */}
      <div className="chat-header">
        <div>
          <div className="chat-title">
            {conversation.channel?.type === 'telegram' ? '📱' : '💬'}{' '}
            {conversation.channel?.displayName}
          </div>
          <div className="chat-subtitle">
            {conversation.participants?.externalUsername || 
             conversation.participants?.externalUserId}
            {' • '}
            Chat ID: {conversation.externalThreadId}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-container">
        {loading ? (
          <div className="messages-loading">Loading messages...</div>
        ) : messages.length === 0 ? (
          <div className="messages-empty">No messages yet</div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`message-bubble ${
                msg.direction === 'outbound'
                  ? 'message-bubble-outbound'
                  : 'message-bubble-inbound'
              }`}
            >
              <div className="message-text">{msg.text}</div>
              <div className="message-time">
                {new Date(msg.createdAt).toLocaleTimeString()}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="input-container">
        <textarea
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type a message..."
          className="message-textarea"
          rows={1}
        />
        <button
          onClick={handleSend}
          disabled={!newMessage.trim() || sending}
          className={`send-button ${
            !newMessage.trim() || sending ? 'send-button-disabled' : ''
          }`}
        >
          {sending ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
