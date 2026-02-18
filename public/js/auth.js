/* global VacationMonitor auth guard */
window.requireAuth = async function requireAuth() {
  try {
    const res = await fetch('/auth/status', { credentials: 'include' });
    if (!res.ok) { window.location.href = '/'; return null; }
    const data = await res.json();
    if (!data.authenticated) { window.location.href = '/'; return null; }
    return data.user;
  } catch {
    window.location.href = '/';
    return null;
  }
};
