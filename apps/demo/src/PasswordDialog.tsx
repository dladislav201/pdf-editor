import { useState } from 'react';
import { Dialog } from './ExportDialogs';
import { useI18n } from './i18n';
import { Icon } from './icons';

/** Asks for the password of a protected PDF; again, with a word of warning, after a wrong one. */
export function PasswordDialog({
  fileName,
  incorrect,
  onAnswer,
}: {
  fileName: string;
  incorrect: boolean;
  /** The password, or null when cancelled. */
  onAnswer: (password: string | null) => void;
}) {
  const p = useI18n().t.password;
  const [password, setPassword] = useState('');
  return (
    <Dialog title={p.title} onClose={() => onAnswer(null)}>
      <form
        className="feedback"
        onSubmit={(e) => {
          e.preventDefault();
          onAnswer(password);
        }}
      >
        <p className="dialog__text">{p.text(fileName)}</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={p.label}
          aria-label={p.label}
          aria-invalid={incorrect || undefined}
        />
        {incorrect && <p className="dialog__error">{p.incorrect}</p>}
        <p className="dialog__note">{p.note}</p>
        <div className="modal__foot">
          <button type="button" className="pill" onClick={() => onAnswer(null)}>
            {p.cancel}
          </button>
          <button type="submit" className="pill pill--ink" disabled={!password}>
            <Icon name="lock" /> {p.open}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
