import { h, setTitle } from '../util.js';
import { emptyState } from '../cards.js';
export default function notFound({ root }) {
  setTitle('Page not found');
  root.append(h('div', { class: 'page narrow' }, emptyState('Page not found', 'The page you are looking for does not exist.', h('a', { class: 'btn primary', href: '/', style: 'margin-top:12px' }, 'Back to home'))));
}
