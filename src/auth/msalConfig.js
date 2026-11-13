import { PublicClientApplication } from '@azure/msal-browser';
import { AZURE_CLIENT_ID } from '../config';
import { createTimedNetworkClient } from './msalNetwork';

// 개발 환경에서는 localhost:3000, 프로덕션에서는 현재 origin 사용
const getRedirectUri = () => {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  return window.location.origin;
};

export const msalConfig = {
  auth: {
    clientId: AZURE_CLIENT_ID,
    authority: 'https://login.microsoftonline.com/common',
    redirectUri: getRedirectUri(),
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: true,
  },
  // 응답이 오지 않는 토큰 요청을 끊는다 — 멈춘 요청에 다음 시도들이 묶여 '오프라인'에서 풀리지 않던 문제 (B-094)
  system: {
    networkClient: createTimedNetworkClient(),
  },
};

export const loginRequest = {
  scopes: ['Files.ReadWrite', 'User.Read'],
};

export const msalInstance = new PublicClientApplication(msalConfig);
