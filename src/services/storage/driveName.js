/**
 * 지금 로그인한 저장소의 이름 — 화면 문구용 (M-1, I-031).
 * App이 로그인한 계정에 맞춰 정한다. 저장소는 로그아웃(페이지 이동) 전까지 바뀌지 않아, 문구를 그릴 때 읽기만 하면 된다.
 */
let current = { name: 'OneDrive', backupPath: 'OneDrive의 Apps/financial-ledger/backups 폴더' };

export function setCurrentDrive(provider) {
  current = provider === 'google'
    ? { name: 'Google Drive', backupPath: 'Google Drive의 financial-ledger/backups 폴더' }
    : { name: 'OneDrive', backupPath: 'OneDrive의 Apps/financial-ledger/backups 폴더' };
}

/** 'OneDrive' | 'Google Drive' */
export function currentDriveName() {
  return current.name;
}

/** 매일 백업이 놓이는 곳(안내 문구) */
export function currentBackupPath() {
  return current.backupPath;
}
