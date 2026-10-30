import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/contract.css';
import './styles.css';
import './theme/elevation.css';
import App from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('渲染入口缺少 #root 节点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
