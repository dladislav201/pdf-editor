import { useState } from 'react';
import { Dialog } from './ExportDialogs';
import { useI18n } from './i18n';
import { Icon } from './icons';
import { sendFeedback, track } from './telemetry';

/** A note to us: what worked, what didn't. An email only if they want an answer. */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const f = useI18n().t.feedback;
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
      setError(e instanceof Error && e.message === 'invalid' ? f.invalid : f.failed);
      setState('editing');
    }
  };

  if (state === 'sent') {
    return (
      <Dialog title={f.thanks} onClose={onClose}>
        <p className="dialog__text">
          {f.read} {email ? f.answer : ''}
        </p>
        <div className="modal__foot">
          <button type="button" className="pill pill--ink" onClick={onClose}>
            {f.done}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={f.title} onClose={onClose}>
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
          placeholder={f.placeholder}
          aria-label={f.message}
        />
        <input
          type="email"
          value={email}
          maxLength={200}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={f.emailPlaceholder}
          aria-label={f.email}
        />
        <input
          className="feedback__trap"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          aria-hidden="true"
        />
        <p className="dialog__note">{f.note}</p>
        {error && <p className="dialog__error">{error}</p>}
        <div className="modal__foot">
          <button type="button" className="pill" onClick={onClose}>
            {f.cancel}
          </button>
          <button type="submit" className="pill pill--ink" disabled={!message.trim() || state === 'sending'}>
            <Icon name="send" /> {state === 'sending' ? f.sending : f.send}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
