// First-run page: the hub's address. The app checks it answers (GET /api/v1/health), saves it,
// then the window goes to the hub.

const texts = {
  fr: {
    title: 'Bienvenue sur MowBot',
    lead: "Indique l'adresse de ton hub MowBot.",
    label: 'Adresse du hub',
    submit: 'Continuer',
    checking: 'Vérification…',
    cancel: 'Revenir au hub actuel',
    hint: 'En local : http://localhost:5173',
    empty: "Indique l'adresse du hub.",
    changeTitle: 'Changer de hub',
  },
  en: {
    title: 'Welcome to MowBot',
    lead: 'Enter the address of your MowBot hub.',
    label: 'Hub address',
    submit: 'Continue',
    checking: 'Checking…',
    cancel: 'Back to the current hub',
    hint: 'Locally: http://localhost:5173',
    empty: 'Enter the hub address.',
    changeTitle: 'Change hub',
  },
};

const lang = navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'fr';
const t = texts[lang];
document.documentElement.lang = lang;
for (const element of document.querySelectorAll('[data-i18n]')) {
  element.textContent = t[element.dataset.i18n];
}

const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);

const form = document.getElementById('form');
const input = document.getElementById('url');
const error = document.getElementById('error');
const submit = document.getElementById('submit');
const cancel = document.getElementById('cancel');

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
}

async function init() {
  // The page's single field.
  input.focus();
  const current = await invoke('hub_url_get').catch(() => null);
  if (!current) return;
  // Changing hub: the current one is prefilled and one click away.
  document.querySelector('h1').textContent = t.changeTitle;
  input.value = current;
  input.select();
  cancel.hidden = false;
  cancel.addEventListener('click', () => {
    window.location.href = current;
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) {
    showError(t.empty);
    return;
  }
  showError('');
  submit.disabled = true;
  submit.textContent = t.checking;
  try {
    // On success the window leaves for the hub.
    await invoke('hub_url_set', { url });
  } catch (caught) {
    showError(String(caught));
    submit.disabled = false;
    submit.textContent = t.submit;
  }
});

init();

// The window's buttons (the window has no system title bar); macOS keeps its traffic lights.
if (/mac/i.test(navigator.userAgent)) document.body.classList.add('mac');
const appWindow = window.__TAURI__?.window.getCurrentWindow();
if (appWindow) {
  document.getElementById('win-minimize').addEventListener('click', () => appWindow.minimize());
  document
    .getElementById('win-maximize')
    .addEventListener('click', () => appWindow.toggleMaximize());
  document.getElementById('win-close').addEventListener('click', () => appWindow.close());
}
for (const [id, fr, en] of [
  ['win-minimize', 'Réduire', 'Minimize'],
  ['win-maximize', 'Agrandir', 'Maximize'],
  ['win-close', 'Fermer', 'Close'],
]) {
  document.getElementById(id).setAttribute('aria-label', lang === 'en' ? en : fr);
}
