import { PublicClientApplication } from '@azure/msal-browser';
import { AZURE_CLIENT_ID } from '../config';

export const msalConfig = {
  auth: {
    clientId: AZURE_CLIENT_ID,
    authority: 'https://login.microsoftonline.com/common',
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: true,
  },
};

export const loginRequest = {
  scopes: ['Files.ReadWrite', 'User.Read'],
};

export const msalInstance = new PublicClientApplication(msalConfig);
