import { loginRequest } from '../auth/msalConfig';
import { ONEDRIVE_DB_PATH } from '../config';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function getToken(instance, accounts) {
  try {
    const res = await instance.acquireTokenSilent({
      ...loginRequest,
      account: accounts[0],
    });
    return res.accessToken;
  } catch {
    // silent 실패 시 redirect로 재인증 (popup 차단 방지)
    await instance.acquireTokenRedirect({ ...loginRequest, account: accounts[0] });
    throw new Error('재인증 중… 잠시 후 자동으로 돌아옵니다.');
  }
}

export async function readDbFromOneDrive(instance, accounts) {
  const token = await getToken(instance, accounts);
  const res = await fetch(
    `${GRAPH_BASE}/me/drive/root:/${ONEDRIVE_DB_PATH}:/content`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 404) return null; // 파일 없음 → 새 DB 생성
  if (!res.ok) throw new Error(`OneDrive 읽기 오류: ${res.status} ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function writeDbToOneDrive(instance, accounts, dbBytes) {
  const token = await getToken(instance, accounts);
  const res = await fetch(
    `${GRAPH_BASE}/me/drive/root:/${ONEDRIVE_DB_PATH}:/content`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: dbBytes,
    }
  );
  if (!res.ok) throw new Error(`OneDrive 저장 오류: ${res.status} ${res.statusText}`);
}
