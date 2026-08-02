// Version strings are passed as query params by the main process.
const params = new URLSearchParams(location.search);
const version = params.get('version') || '';
const electron = params.get('electron') || '';
document.getElementById('version').textContent =
  version ? `Version ${version}${electron ? ` · Electron ${electron}` : ''}` : '';
