// Classic script (not a module) so the saved theme applies before first paint.
try {
  const t = localStorage.getItem('ruby-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch {
  /* storage unavailable: follow the system theme */
}
