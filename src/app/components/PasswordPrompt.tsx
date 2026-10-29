import { useId, useRef, useState } from 'react';
import { removeFile, unlock, type FileEntry } from '../store';

/** Shown instead of the editor when a file needs a password to be opened. */
export function PasswordPrompt({ file }: { file: FileEntry }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const errId = useId();
  const wrong = file.errorCode === 'wrong-password';
  return (
    <div className="state-box">
      <h3>Password protected</h3>
      <p>
        <b>{file.name}</b> is encrypted. Enter its password to view and clean it. The password stays in this tab and
        is never stored; cleaned copies are saved without a password.
      </p>
      <form
        className="password-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!password || busy) return;
          setBusy(true);
          const ok = await unlock(file.id, password);
          setBusy(false);
          if (!ok) {
            setPassword('');
            input.current?.focus();
          }
        }}
      >
        <label>
          Password
          <input
            ref={input}
            className={`input${wrong ? ' invalid' : ''}`}
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            aria-invalid={wrong}
            aria-describedby={wrong ? errId : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="btn primary" type="submit" aria-disabled={!password || busy}>
          {busy && <span className="spinner sm" aria-hidden="true" />} Unlock
        </button>
      </form>
      {wrong && (
        <p className="field-error" id={errId} role="alert">
          That password did not open the file. Try again.
        </p>
      )}
      <button className="btn text sm" type="button" onClick={() => removeFile(file.id)}>
        Remove from list
      </button>
    </div>
  );
}
