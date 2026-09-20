/**
 * @module ownerSignInDialog
 * @description The compact "Owner Controls" sign-in dialog.
 *
 * The token is read from the password field once, handed to `submit`, and the
 * field is emptied as soon as the request settles - success or failure. It is
 * never written to storage, a URL, the DOM (as text) or a log line, and the
 * field never echoes it (type="password").
 */

const DIALOG_ID = 'owner-signin-dialog';

/**
 * @param {{ submit: (token: string) => Promise<boolean>, opener?: HTMLElement|null, doc?: Document }} options
 * @returns {{ close: () => void, element: HTMLElement }|null} null when already open.
 */
export function openOwnerSignInDialog({ submit, opener = null, doc = globalThis.document }) {
  if (!doc || doc.getElementById(DIALOG_ID)) return null;

  const dialog = doc.createElement('div');
  dialog.id = DIALOG_ID;
  dialog.className = 'owner-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'owner-dialog-title');

  const title = doc.createElement('h2');
  title.id = 'owner-dialog-title';
  title.className = 'owner-dialog-title';
  title.textContent = 'Owner Controls';

  const form = doc.createElement('form');
  form.className = 'owner-dialog-form';
  form.noValidate = true;

  const label = doc.createElement('label');
  label.className = 'owner-dialog-label';
  label.setAttribute('for', 'owner-dialog-token');
  label.textContent = 'Admin token:';

  const input = doc.createElement('input');
  input.id = 'owner-dialog-token';
  input.className = 'owner-dialog-input';
  input.type = 'password';
  input.name = 'owner-admin-token';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('maxlength', '256');

  const error = doc.createElement('p');
  error.className = 'owner-dialog-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const actions = doc.createElement('div');
  actions.className = 'owner-dialog-actions';
  const signIn = doc.createElement('button');
  signIn.type = 'submit';
  signIn.className = 'owner-dialog-btn owner-dialog-primary';
  signIn.textContent = 'Sign in';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'owner-dialog-btn';
  cancel.textContent = 'Cancel';
  actions.append(signIn, cancel);

  form.append(label, input, error, actions);
  dialog.append(title, form);

  function close() {
    input.value = '';
    dialog.remove();
    doc.removeEventListener('keydown', onKeydown, true);
    try { opener?.focus?.(); } catch { /* the opener may be gone */ }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [input, signIn, cancel].filter((el) => !el.disabled);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = input.value;
    if (!token) {
      error.textContent = 'Enter the admin token.';
      error.hidden = false;
      input.focus();
      return;
    }
    signIn.disabled = true;
    cancel.disabled = true;
    input.disabled = true;
    error.hidden = true;
    let ok = false;
    try {
      ok = await submit(token);
    } catch {
      ok = false;
    } finally {
      input.value = ''; // cleared the moment the request settles, whatever the outcome
      input.disabled = false;
      signIn.disabled = false;
      cancel.disabled = false;
    }
    if (ok) {
      close();
      return;
    }
    error.textContent = 'Sign-in failed.';
    error.hidden = false;
    input.focus();
  });
  cancel.addEventListener('click', close);
  doc.addEventListener('keydown', onKeydown, true);

  doc.body.appendChild(dialog);
  input.focus();
  return { close, element: dialog };
}
