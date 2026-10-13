import './styles.css';

import { bootstrap } from './bootstrap.js';
import { readBrowserEnvironment } from './capabilities.js';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

void bootstrap({
  container,
  env: readBrowserEnvironment(window),
  notifications: 'Notification' in window ? Notification : undefined,
});
