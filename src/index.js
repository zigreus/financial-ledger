import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './components/App/App';
import { MsalProvider } from '@azure/msal-react';
import { msalInstance } from './auth/msalConfig';
import { registerServiceWorker } from './services/serviceWorker';

// 연결 없이 열기·공유 받기 (I-024)
registerServiceWorker();

msalInstance.initialize().then(() => {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </React.StrictMode>
  );
});
