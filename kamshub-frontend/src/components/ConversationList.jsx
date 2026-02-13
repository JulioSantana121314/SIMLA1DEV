import './ConversationList.css';

export default function ConversationList({
  conversations,
  selectedId,
  onSelect,
  loading,
  error,
}) {
  if (loading) {
    return (
      <div className="conversation-sidebar">
        <div className="conversation-loading">Loading conversations...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="conversation-sidebar">
        <div className="conversation-error">{error}</div>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="conversation-sidebar">
        <div className="conversation-empty">No conversations yet</div>
      </div>
    );
  }

  return (
    <div className="conversation-sidebar">
      <div className="conversation-list">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            onClick={() => onSelect(conv.id)}
            className={`conversation-item ${
              selectedId === conv.id ? 'conversation-item-selected' : ''
            }`}
          >
            {/* Icono del canal */}
            <div className="channel-icon">
              {conv.channel?.type === 'telegram' ? '📱' : '💬'}
            </div>

            <div className="conversation-content">
              {/* Nombre del canal */}
              <div className="conversation-header">
                <span className="channel-name">
                  {conv.channel?.displayName || 'Unknown Channel'}
                </span>
                <span className="conversation-timestamp">
                  {formatTimestamp(conv.lastMessageAt)}
                </span>
              </div>

              {/* Participante + preview */}
              <div className="conversation-preview">
                <span className="participant-name">
                  {conv.participants?.externalUsername || 
                   conv.participants?.externalUserId || 
                   'Unknown'}
                </span>
                <span className="message-preview">
                  {conv.lastMessagePreview || 'No messages'}
                </span>
              </div>
            </div>

            {/* Badge de no leídos */}
            {conv.unreadCount > 0 && (
              <div className="unread-badge">{conv.unreadCount}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString();
}
