import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// E2E diagnostics: collect uncaught errors so browser tests can assert on them.
declare global {
  interface Window {
    __errs?: string[];
  }
}
window.__errs = window.__errs ?? [];
window.addEventListener('error', (e) => window.__errs?.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errs?.push(String(e.reason)));

const container = document.getElementById('root');
if (!container) throw new Error('#root container missing');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
