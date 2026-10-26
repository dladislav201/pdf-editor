import { useState } from 'react';
import { Dialog } from './ExportDialogs';
import { Icon } from './icons';
import { sendFeedback, track } from './telemetry';

/** A note to us: what worked, what didn't. An email only if they want an answer. */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  // Hidden from people; bots fill it in.
  const [website, setWebsite] = useState('');
  const [state, setState] = useState<'editing' | 'sending' | 'sent'>('editing');
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setState('sending');
    setError(null);
    try {
      await sendFeedback({ message, email, website });
      track('feedback.sent');
      setState('sent');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('editing');
    }
  };

  if (state === 'sent') {
    return (
      <Dialog title="Thank you" onClose={onClose}>
        <p className="dialog__text">We read every note. {email ? 'If you asked something, we’ll write back.' : ''}</p>
        <div className="modal__foot">
          <button type="button" className="pill pill--ink" onClick={onClose}>
            Done
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Send feedback" onClose={onClose}>
      <form
        className="feedback"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          autoFocus
          value={message}
          maxLength={4000}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What worked, what didn’t, what you’d like to see…"
          aria-label="Your feedback"
        />
        <input
          type="email"
          value={email}
          maxLength={200}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email, if you’d like an answer (optional)"
          aria-label="Email (optional)"
        />
        <input
          className="feedback__trap"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          aria-hidden="true"
        />
        <p className="dialog__note">Your files are never sent. Don’t paste anything private here.</p>
        {error && <p className="dialog__error">{error}</p>}
        <div className="modal__foot">
          <button type="button" className="pill" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="pill pill--ink" disabled={!message.trim() || state === 'sending'}>
            <Icon name="send" /> {state === 'sending' ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
