import './EmptyState.css';

export default function EmptyState() {
  return (
    <div className="empty-state-container">
      <div className="empty-state-icon">💬</div>
      <div className="empty-state-title">No conversation selected</div>
      <div className="empty-state-subtitle">
        Select a conversation from the list to start chatting
      </div>
    </div>
  );
}
