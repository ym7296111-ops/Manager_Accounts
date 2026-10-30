import { createRoot } from 'react-dom/client';
import PreviewApp from './PreviewApp';
import './preview.css';

const container = document.getElementById('root');
if (container !== null) createRoot(container).render(<PreviewApp />);
